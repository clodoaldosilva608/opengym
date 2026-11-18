/* Smoke test end-to-end da EDIÇÃO SERVERLESS (frontend/serverless/core.js).
   Sobe scripts/dev-serverless.mjs com DATA_BACKEND=fs (disco temporário) e exercita:
   run 1 — migração (dono pré-existente fica isento), painel admin, acesso liberado;
   run 2 — usuário vencido → 402 no /api/data → checkout Pix → aprovação no painel
           → acesso ativo → isenção → desafios WebAuthn persistidos → timers/lembrete;
   run 3 — fluxo Cakto: checkout Pix automático (API mockada), validação de pagador,
           webhook assinado (HMAC) aprova sozinho, idempotência, revogação por reembolso.
   Uso: node scripts/smoke-serverless.mjs   (a partir da raiz do repo)         */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
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

/* ---------- run 3: fluxo Cakto (API mockada + webhook assinado) ---------- */

/* Mock mínimo da API pública do Cakto: POST /token/ e POST /payments/. */
function mockCakto(port) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', d => chunks.push(d));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (req.url.startsWith('/token/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ access_token: 'mock-jwt-token', token_type: 'Bearer', expires_in: 36000, scope: 'read write payments' }));
      }
      if (req.url.startsWith('/payments/')) {
        if (req.headers['authorization'] !== 'Bearer mock-jwt-token') { res.writeHead(401); return res.end(JSON.stringify({ detail: 'As credenciais de autenticação não foram fornecidas.' })); }
        if (!req.headers['x-idempotency-key']) { res.writeHead(400); return res.end(JSON.stringify({ detail: 'Header X-Idempotency-Key é obrigatório.' })); }
        const body = JSON.parse(raw || '{}');
        res.writeHead(201, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          id: 'mock-' + crypto.randomBytes(6).toString('hex'),
          refId: 'MOCK' + crypto.randomBytes(3).toString('hex').toUpperCase(),
          status: 'waiting_payment',
          paymentMethod: 'pix',
          amount: '14.90',
          baseAmount: '14.90',
          discount: '0.00',
          fees: '0.00',
          checkoutUrl: 'https://pay.cakto.com.br/MOCKTEST',
          createdAt: new Date().toISOString(),
          product: { id: 'prod-mock', short_id: 'mp1', name: 'openGym — Plano Mensal' },
          offer: { id: body?.items?.[0]?.offerId || 'cvgtest', name: 'openGym — Plano Mensal', price: 14.9 },
          pix: { qrCode: '00020126BR.GOV.BCB.PIX0114MOCKMOCKMOCKMOCK5204000053039865802BR6009SAO PAULO62070503***6304ABCD', expirationDate: new Date(Date.now() + 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19) + '+00:00' },
          user_journey: null
        }));
      }
      res.writeHead(404); res.end('{}');
    });
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(server)));
}

/* Assina um payload de webhook exatamente como a Cakto faz:
   X-Cakto-Signature: v1=HMAC-SHA256(secret, '{timestamp}.{rawBody}') */
function signedWebhookHeaders(secret, body) {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = crypto.createHmac('sha256', secret).update(ts + '.' + raw).digest('hex');
  return { headers: { ...J, 'X-Cakto-Timestamp': ts, 'X-Cakto-Signature': 'v1=' + sig }, raw };
}

async function run3() {
  console.log('\n— Run 3: Cakto — Pix automático + webhook assinado —');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ogsmoke3-'));
  const past = new Date(Date.now() - 3 * 86400000).toISOString();
  tempDb(dir, { users: [{ id: 'u3', name: 'Aluna Vencida', created: past, billing: { status: 'trial', free: false, trialEndsAt: past, periodEnd: null } }], creds: [], subs: [], invites: [] });
  const WHSEC = 'whsec-test-0000';
  const mock = await mockCakto(3315);
  const child = spawn('node', ['scripts/dev-serverless.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(3316), DATA_BACKEND: 'fs', DATA_DIR: dir,
      RP_ID: 'localhost', ORIGIN: `http://localhost:3316`,
      ADMIN_USERNAME: 'dono', ADMIN_PASSWORD: 'senhaforte123',
      TRIAL_DAYS: '7', PRICE_MONTHLY: '14.90', APP_BRAND: 'openGym',
      VAPID_SUBJECT: 'mailto:smoke@teste',
      CAKTO_CLIENT_ID: 'cid-teste', CAKTO_CLIENT_SECRET: 'csec-teste', CAKTO_OFFER_ID: 'cvgtest',
      CAKTO_WEBHOOK_SECRET: WHSEC, CAKTO_BASE_URL: 'http://127.0.0.1:3315/'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stderr.on('data', d => process.env.SMOKE_DEBUG && process.stderr.write(d));
  const base = 'http://localhost:3316';
  try {
    await waitHealth(3316);
    const cfg = await (await fetch(base + '/api/config')).json();
    ok(cfg.billing?.method === 'cakto', `config: método de pagamento → ${cfg.billing?.method}`);
    ok(!JSON.stringify(cfg).includes('csec-teste'), 'config pública não vaza credenciais');

    const cookie = sessionCookie(dir, 'u3');
    // valida pagador: e-mail ausente/inválido, telefone, CPF
    const c1 = await fetch(base + '/api/billing/checkout', { method: 'POST', headers: { ...J, cookie }, body: '{}' });
    ok(c1.status === 400 && (await c1.json()).field === 'email', 'checkout sem e-mail → 400 (field=email)');
    const c2 = await fetch(base + '/api/billing/checkout', { method: 'POST', headers: { ...J, cookie }, body: JSON.stringify({ email: 'aluna@teste.com', phone: '123' }) });
    ok(c2.status === 400 && (await c2.json()).field === 'phone', 'telefone inválido → 400 (field=phone)');
    const c3 = await fetch(base + '/api/billing/checkout', { method: 'POST', headers: { ...J, cookie }, body: JSON.stringify({ email: 'aluna@teste.com', phone: '(11) 91234-5678', docNumber: '11111111111' }) });
    ok(c3.status === 400 && (await c3.json()).field === 'docNumber', 'CPF dígito verificador inválido → 400 (field=docNumber)');

    // checkout válido → cobrança Pix do mock
    const ck = await (await fetch(base + '/api/billing/checkout', {
      method: 'POST', headers: { ...J, cookie },
      body: JSON.stringify({ email: 'Aluna@Teste.com', phone: '(11) 91234-5678', docNumber: '529.982.247-25' })
    })).json();
    ok(ck.payment?.status === 'pending' && ck.payment?.method === 'cakto', `checkout cakto: ${ck.payment?.status}/${ck.payment?.method}`);
    ok((ck.payment?.qrCode || '').startsWith('00020126'), 'payment traz o BR Code (copia-e-cola)');
    ok(ck.payment?.checkoutUrl === 'https://pay.cakto.com.br/MOCKTEST', 'payment traz o checkoutUrl da Cakto');
    ok(!ck.pix, 'fluxo cakto não devolve chave Pix manual');

    // restauração da pendência depois de recarregar a página
    const pend = await (await fetch(base + '/api/billing/pending', { headers: { cookie } })).json();
    ok(pend.payment?.id === ck.payment.id && pend.payment?.qrCode === ck.payment.qrCode, 'GET /api/billing/pending restaura o QR');

    // idempotência do checkout (mesma cobrança pendente)
    const ck2 = await (await fetch(base + '/api/billing/checkout', {
      method: 'POST', headers: { ...J, cookie },
      body: JSON.stringify({ email: 'aluna@teste.com', phone: '11 91234-5678', docNumber: '52998224725' })
    })).json();
    ok(ck2.payment?.id === ck.payment.id, 'checkout cakto é idempotente');

    // webhook rejeitado sem verificação válida / com assinatura errada
    const whBody = { secret: WHSEC, event: 'purchase_approved', data: { id: ck.payment.caktoId, refId: ck.payment.refId, status: 'paid', amount: 14.9, paymentMethod: 'pix', customer: { email: 'aluna@teste.com' }, product: {}, offer: {} } };
    const noAuth = { ...whBody, secret: undefined }; delete noAuth.secret;   // sem secret no corpo
    const w0 = await fetch(base + '/api/billing/webhook', { method: 'POST', headers: J, body: JSON.stringify(noAuth) });
    ok(w0.status === 403, 'webhook sem assinatura de header e sem secret no corpo → 403');
    const wrong = signedWebhookHeaders('segredo-errado', noAuth);
    const w1 = await fetch(base + '/api/billing/webhook', { method: 'POST', headers: wrong.headers, body: wrong.raw });
    ok(w1.status === 403, 'webhook com assinatura inválida → 403');

    // aprovação: /api/me ainda overdue antes do webhook
    const me0 = await (await fetch(base + '/api/me', { headers: { cookie } })).json();
    ok(me0.user?.billing?.code === 'overdue', 'antes do webhook: overdue');

    // caminho 1 (fallback da doc): assinatura de header errada + secret correto no corpo
    const fallback = signedWebhookHeaders('segredo-errado', whBody);
    const w2 = await fetch(base + '/api/billing/webhook', { method: 'POST', headers: fallback.headers, body: fallback.raw });
    const w2j = await w2.json();
    ok(w2.status === 200 && w2j.ok === true && w2j.outcome === 'approved', `webhook (fallback secret no corpo) → ${w2j.outcome}`);
    const me1 = await (await fetch(base + '/api/me', { headers: { cookie } })).json();
    ok(me1.user?.billing?.code === 'active', 'após webhook: assinatura ativa');
    const put = await fetch(base + '/api/data', { method: 'PUT', headers: { ...J, cookie }, body: JSON.stringify({ state: { unit: 'kg' } }) });
    ok(put.status === 200, 'PUT /api/data liberado após aprovação automática');
    const periodEnd1 = me1.user?.billing?.periodEnd;

    // idempotência do webhook: repetir o evento (agora com assinatura de header correta) não prorroga duas vezes
    const good = signedWebhookHeaders(WHSEC, whBody);
    const w3 = await fetch(base + '/api/billing/webhook', { method: 'POST', headers: good.headers, body: good.raw });
    const w3j = await w3.json();
    ok(w3j.outcome === 'already-approved', 'webhook repetido → already-approved');
    const me2 = await (await fetch(base + '/api/me', { headers: { cookie } })).json();
    ok(me2.user?.billing?.periodEnd === periodEnd1, 'periodEnd não avança na repetição');

    // reembolso → revoga o acesso
    const refund = { secret: WHSEC, event: 'refund', data: { id: ck.payment.caktoId, refId: ck.payment.refId, status: 'refunded', amount: 14.9, customer: { email: 'aluna@teste.com' } } };
    const goodR = signedWebhookHeaders(WHSEC, refund);
    const w4 = await fetch(base + '/api/billing/webhook', { method: 'POST', headers: goodR.headers, body: goodR.raw });
    ok((await w4.json()).outcome === 'revoked', 'webhook refund → revogado');
    const me3 = await (await fetch(base + '/api/me', { headers: { cookie } })).json();
    ok(me3.user?.billing?.code === 'overdue', 'após reembolso: acesso cortado');
    const put2 = await fetch(base + '/api/data', { method: 'PUT', headers: { ...J, cookie }, body: JSON.stringify({ state: { unit: 'kg', _ts: 9 } }) });
    ok(put2.status === 402, 'PUT /api/data bloqueado de novo (402)');

    // venda direta no checkout público da Cakto (sem cobrança local): casa por e-mail
    const direct = { secret: WHSEC, event: 'purchase_approved', data: { id: 'mock-direct-01', refId: 'MOCKD1', status: 'paid', amount: 14.9, paymentMethod: 'credit_card', customer: { name: 'Aluna Vencida', email: 'aluna@teste.com' }, product: { id: 'prod-mock' }, offer: { id: 'cvgtest' } } };
    const goodD = signedWebhookHeaders(WHSEC, direct);
    const w5 = await fetch(base + '/api/billing/webhook', { method: 'POST', headers: goodD.headers, body: goodD.raw });
    const w5j = await w5.json();
    ok(w5j.outcome === 'approved', `venda direta no checkout → ${w5j.outcome} (casada por e-mail)`);
    const me4 = await (await fetch(base + '/api/me', { headers: { cookie } })).json();
    ok(me4.user?.billing?.code === 'active', 'venda direta liberou o acesso');
  } finally {
    child.kill('SIGKILL');
    mock.close();
  }
}

try {
  await run1();
  await run2();
  await run3();
} catch (e) {
  console.error('ERRO:', e.message);
  failures++;
}
console.log(`\n${failures ? '✘ ' + failures + ' falha(s)' : '✔ smoke serverless completo: tudo certo'}`);
process.exit(failures ? 1 : 0);
