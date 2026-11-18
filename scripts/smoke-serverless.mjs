/* Smoke test end-to-end da EDIÇÃO SERVERLESS (frontend/serverless/core.js).
   Sobe scripts/dev-serverless.mjs com DATA_BACKEND=fs (disco temporário) e exercita:
   run 1 — migração (dono pré-existente fica isento), painel admin, acesso liberado;
   run 2 — usuário vencido → 402 no /api/data → checkout Pix → aprovação no painel
           → acesso ativo → isenção → desafios WebAuthn persistidos → timers/lembrete.
   Uso: node scripts/smoke-serverless.mjs   (a partir da raiz do repo)         */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = new URL('..', import.meta.url).pathname;
let failures = 0;

const ok = (cond, label) => {
  console.log((cond ? '  ✔ ' : '  ✘ ') + label);
  if (!cond) failures++;
};

function tempDb(dir, db) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'db'), JSON.stringify(db)); }

function secretOf(dir) { return fs.readFileSync(path.join(dir, 'secret'), 'utf8').trim(); }

function sessionCookie(dir, uid) {
  const SECRET = secretOf(dir);
  const payload = `${uid}:${Date.now() + 86400000}:0`;
  const mac = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return `gymsid=${payload}.${mac}`;
}

function boot(port, dataDir) {
  const child = spawn('node', ['scripts/dev-serverless.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port), DATA_BACKEND: 'fs', DATA_DIR: dataDir,
      RP_ID: 'localhost', ORIGIN: `http://localhost:${port}`,
      ADMIN_USERNAME: 'dono', ADMIN_PASSWORD: 'senhaforte123',
      PIX_KEY: 'dono@teste.com', PIX_HOLDER: 'Dono do Serviço',
      TRIAL_DAYS: '7', PRICE_MONTHLY: '14.90', APP_BRAND: 'openGym',
      VAPID_SUBJECT: 'mailto:smoke@teste',
      MP_WEBHOOK_URL: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stderr.on('data', d => process.env.SMOKE_DEBUG && process.stderr.write(d));
  child.on('exit', c => { if (c && c !== 0) console.error('server saiu com código', c); });
  return child;
}

async function waitHealth(port, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(`http://localhost:${port}/api/health`); if (r.ok) return await r.json(); } catch { /* bootando */ }
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error('server não subiu');
}

const J = { 'Content-Type': 'application/json' };

async function run1() {
  console.log('\n— Run 1: migração e dono isento —');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ogsmoke1-'));
  tempDb(dir, { users: [{ id: 'u1', name: 'Dono Histórico', created: new Date().toISOString() }], creds: [], subs: [], invites: [] });
  const child = boot(3311, dir);
  const base = `http://localhost:3311`;
  try {
    const h = await waitHealth(3311);
    ok(h.ok === true && h.backend === 'fs', `health ok (backend=${h.backend})`);
    const cfg = await (await fetch(base + '/api/config')).json();
    ok(cfg.billing?.price === 14.9 && cfg.billing?.method === 'pix', `config pública: preço ${cfg.billing?.price}, método ${cfg.billing?.method}`);
    ok(cfg.brand === 'openGym', 'brand na config');
    ok(cfg.coach === undefined, 'coach ausente na config (serverless)');
    const cookie = sessionCookie(dir, 'u1');
    const me = await (await fetch(base + '/api/me', { headers: { cookie } })).json();
    ok(me.user?.billing?.code === 'free', `migração: dono pré-existente → ${me.user?.billing?.code}`);
    const put = await fetch(base + '/api/data', { method: 'PUT', headers: { ...J, cookie }, body: JSON.stringify({ state: { unit: 'kg', _ts: 1 } }) });
    ok(put.status === 200, 'PUT /api/data liberado para isento');
    const get = await fetch(base + '/api/data', { headers: { cookie } });
    ok((await get.json()).state?.unit === 'kg', 'GET /api/data devolve o estado salvo');
    const noAuth = await fetch(base + '/api/data');
    ok(noAuth.status === 401, 'sem sessão → 401');
    const login = await fetch(base + '/api/panel/login', { method: 'POST', headers: J, body: JSON.stringify({ username: 'dono', password: 'senhaforte123' }) });
    ok(login.status === 200, 'painel: credencial de env criada no boot');
    const pcookie = (login.headers.get('set-cookie') || '').split(';')[0];
    ok(pcookie.startsWith('ogadmin='), 'painel: cookie separado (ogadmin)');
    const coach = await fetch(base + '/api/coach/status', { headers: { cookie } });
    ok(coach.status === 503, 'coach → 503 na edição serverless');
  } finally { child.kill('SIGKILL'); }
}

async function run2() {
  console.log('\n— Run 2: vencido → checkout Pix → aprovação no painel —');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ogsmoke2-'));
  const past = new Date(Date.now() - 3 * 86400000).toISOString();
  tempDb(dir, { users: [{ id: 'u2', name: 'Vencido de Teste', created: past, billing: { status: 'trial', free: false, trialEndsAt: past, periodEnd: null } }], creds: [], subs: [], invites: [] });
  const child = boot(3312, dir);
  const base = `http://localhost:3312`;
  try {
    await waitHealth(3312);
    const cookie = sessionCookie(dir, 'u2');
    const me = await (await fetch(base + '/api/me', { headers: { cookie } })).json();
    ok(me.user?.billing?.code === 'overdue', 'trial vencido → overdue');
    const put = await fetch(base + '/api/data', { method: 'PUT', headers: { ...J, cookie }, body: JSON.stringify({ state: { unit: 'kg' } }) });
    ok(put.status === 402, `PUT /api/data bloqueado: ${put.status} (402 esperado)`);
    const gated = await put.json();
    ok(gated?.billing?.code === 'overdue', '402 traz o resumo de billing');

    const ck = await (await fetch(base + '/api/billing/checkout', { method: 'POST', headers: { ...J, cookie }, body: '{}' })).json();
    ok(ck.payment?.status === 'pending' && ck.payment?.method === 'pix', `checkout: ${ck.payment?.id?.slice(0, 12)}… (${ck.payment?.status}/${ck.payment?.method})`);
    ok(ck.pix?.key === 'dono@teste.com', 'checkout devolve a chave Pix');
    const ck2 = await (await fetch(base + '/api/billing/checkout', { method: 'POST', headers: { ...J, cookie }, body: '{}' })).json();
    ok(ck2.payment?.id === ck.payment?.id, 'checkout é idempotente (mesma cobrança)');

    const bad = await fetch(base + '/api/panel/login', { method: 'POST', headers: J, body: JSON.stringify({ username: 'dono', password: 'errada' }) });
    ok(bad.status === 401, 'painel: senha errada → 401');
    const login = await fetch(base + '/api/panel/login', { method: 'POST', headers: J, body: JSON.stringify({ username: 'dono', password: 'senhaforte123' }) });
    ok(login.status === 200, 'painel: login ok');
    const pcookie = (login.headers.get('set-cookie') || '').split(';')[0];
    const pm = await (await fetch(base + '/api/panel/me', { headers: { cookie: pcookie } })).json();
    ok(pm.username === 'dono', 'painel: /panel/me ok');
    const panelBlocked = await fetch(base + '/api/panel/overview');
    ok(panelBlocked.status === 401, 'painel: sem cookie → 401');

    const ov = await (await fetch(base + '/api/panel/overview', { headers: { cookie: pcookie } })).json();
    ok(ov.users === 1 && ov.by.overdue === 1 && ov.pendingPayments === 1, `overview: ${ov.users} usuário, ${ov.by.overdue} vencido, ${ov.pendingPayments} pendente`);
    const pu = await (await fetch(base + '/api/panel/users', { headers: { cookie: pcookie } })).json();
    ok(pu.users[0]?.billing?.code === 'overdue' && pu.users[0]?.billing?.pendingId === ck.payment.id, 'painel/users: status + pendência visíveis');

    const ap = await (await fetch(base + '/api/panel/payment/approve', { method: 'POST', headers: { ...J, cookie: pcookie }, body: JSON.stringify({ id: ck.payment.id }) })).json();
    ok(ap.ok === true && ap.billing?.code === 'active', 'painel: aprovação Pix → ativo');
    const me2 = await (await fetch(base + '/api/me', { headers: { cookie } })).json();
    ok(me2.user?.billing?.code === 'active', `usuário agora: ${me2.user?.billing?.code}`);
    const put2 = await fetch(base + '/api/data', { method: 'PUT', headers: { ...J, cookie }, body: JSON.stringify({ state: { unit: 'kg', _ts: 2 } }) });
    ok(put2.status === 200, 'PUT /api/data liberado após aprovação');

    // desafios WebAuthn persistidos no storage: options → cid; verify com lixo deve dar
    // 'verification failed' (desafio foi lido do storage) e não 'challenge expired'
    const opt = await (await fetch(base + '/api/register/options', { method: 'POST', headers: J, body: JSON.stringify({ name: 'Teste' }) })).json();
    ok(!!opt.cid && !!opt.options?.challenge, 'register/options devolve cid + challenge');
    const challengeFile = path.join(dir, 'challenge-' + opt.cid);
    ok(fs.existsSync(challengeFile), 'desafio persistido no storage');
    const fake = await fetch(base + '/api/register/verify', { method: 'POST', headers: J, body: JSON.stringify({ cid: opt.cid, credential: { id: 'x', response: {} } }) });
    ok(fake.status === 400 && (await fake.json()).error.startsWith('verification failed'), 'register/verify leu o desafio persistido');

    // timer de descanso → timers.json; cancel → some
    const rt = await fetch(base + '/api/push/rest-timer', { method: 'POST', headers: { ...J, cookie }, body: JSON.stringify({ seconds: 60 }) });
    ok(rt.status === 200, 'rest-timer aceito');
    const timers = JSON.parse(fs.readFileSync(path.join(dir, 'timers'), 'utf8'));
    ok(timers.u2 > Date.now(), 'timer registrado no storage');
    await fetch(base + '/api/push/rest-timer/cancel', { method: 'POST', headers: { ...J, cookie }, body: '{}' });
    const timers2 = JSON.parse(fs.readFileSync(path.join(dir, 'timers'), 'utf8'));
    ok(!( 'u2' in timers2), 'cancel removeu o timer');

    // lembrete: PUT com reminder.on → índice reminders.json
    await fetch(base + '/api/data', { method: 'PUT', headers: { ...J, cookie }, body: JSON.stringify({ state: { unit: 'kg', reminder: { on: true, time: '07:30', tz: 'America/Sao_Paulo' } } }) });
    await new Promise(r => setTimeout(r, 400));
    const rems = JSON.parse(fs.readFileSync(path.join(dir, 'reminders'), 'utf8'));
    ok(rems.u2?.time === '07:30' && rems.u2?.tz === 'America/Sao_Paulo', 'índice de lembretes mantido pelo PUT /api/data');

    const fr = await (await fetch(base + '/api/panel/user/free', { method: 'POST', headers: { ...J, cookie: pcookie }, body: JSON.stringify({ id: 'u2', free: true }) })).json();
    ok(fr.billing?.code === 'free', 'painel: concede isenção');
    const me3 = await (await fetch(base + '/api/me', { headers: { cookie } })).json();
    ok(me3.user?.billing?.code === 'free', 'usuário → isento');
    const ext = await fetch(base + '/api/panel/user/extend', { method: 'POST', headers: { ...J, cookie: pcookie }, body: JSON.stringify({ id: 'u2', days: 30 }) });
    ok(ext.status === 400, 'extensão bloqueada para isento');

    const out = await fetch(base + '/api/panel/logout', { method: 'POST', headers: { ...J, cookie: pcookie }, body: '{}' });
    ok((out.headers.get('set-cookie') || '').includes('ogadmin=;'), 'painel: logout limpa o cookie');
    const pm2 = await fetch(base + '/api/panel/me', { headers: { cookie: pcookie } });
    ok(pm2.status === 401, 'painel: sessão encerrada → 401');
  } finally { child.kill('SIGKILL'); }
}

try {
  await run1();
  await run2();
} catch (e) {
  console.error('ERRO:', e.message);
  failures++;
}
console.log(`\n${failures ? '✘ ' + failures + ' falha(s)' : '✔ smoke serverless completo: tudo certo'}`);
process.exit(failures ? 1 : 0);
