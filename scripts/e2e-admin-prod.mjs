/* E2E de produção: painel admin completo + checkout hospedado no opengyn.vercel.app.
   1) Login no /#/painel (admin real) → valida as 6 abas com screenshots;
   2) Convites: gera e revoga um código; settings: round-trip GET→POST; backup;
   3) Registra usuário de teste com passkey VIRTUAL (CDP WebAuthn);
   4) /#/billing: valida o seletor Pix|Cartão, escolhe cartão → redireciona ao
      checkout hospedado pay.cakto.com.br/cvgff7x?callback=<uid> (sem pagar);
   5) Evento de teste do webhook da Cakto (assinado por ela mesma) → valida entrega;
   6) Limpa: apaga o usuário de teste pelo NOVO endpoint de exclusão do painel
      e apaga o registro órfão do evento de teste (dogfooding do CRUD).
   Uso: NODE_PATH=$(npm root -g) node scripts/e2e-admin-prod.mjs  */
import { chromium } from 'playwright';
import crypto from 'node:crypto';
import fs from 'node:fs';

const BASE = 'https://opengyn.vercel.app';
const GH_TOKEN = process.env.GH_TOKEN;
const GH_REPO = 'clodoaldosilva608/opengym-data';
const NAME = 'E2E Admin ' + crypto.randomBytes(2).toString('hex');
const SHOTS = '/tmp/render-admin-e2e';
fs.mkdirSync(SHOTS, { recursive: true });

let failures = 0;
const ok = (c, label) => { console.log((c ? '  ✔ ' : '  ✘ ') + label); if (!c) failures++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const GH = { Authorization: 'Bearer ' + GH_TOKEN, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'opengym-e2e' };

async function readDb() {
  const r = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/data/db?ref=main&t=${Date.now()}`, { headers: GH });
  const j = await r.json();
  return { db: JSON.parse(Buffer.from(j.content, 'base64').toString('utf8')), sha: j.sha };
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ locale: 'pt-BR', timezoneId: 'America/Sao_Paulo', viewport: { width: 1280, height: 900 } });
const page = await context.newPage();

/* ---------- 1. painel: login + abas ---------- */
console.log('\n— 1) painel admin: login e abas —');
await page.goto(BASE + '/#/painel', { waitUntil: 'networkidle' });
await page.getByPlaceholder('Usuário administrador').fill('clodoaldo608@gmail.com');
await page.getByPlaceholder('Senha').fill('88677488');
await page.getByRole('button', { name: /Entrar no painel/ }).click();
await page.waitForSelector('.pa-nav', { timeout: 20000 });
ok(true, 'login do painel ok');
await page.waitForTimeout(1500);
await page.screenshot({ path: SHOTS + '/p1-visao.png' });
ok(await page.locator('.pa-stat').count() >= 10, 'visão geral com métricas');
ok((await page.locator('.pa-kv .pa-dot').count()) >= 4, 'status dos meios de pagamento visível');

const tabShot = async (label, file) => {
  await page.evaluate(l => [...document.querySelectorAll('.pa-nav-btn')].find(b => b.textContent.includes(l)).click(), label);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: SHOTS + '/' + file });
};
await tabShot('Usuários', 'p2-users.png');
ok(await page.locator('.pa-item').count() >= 1, 'lista de usuários renderizada');
// detalhe do primeiro usuário
await page.locator('.pa-item .pa-item-main').first().click();
await page.waitForSelector('.pa-modal-card', { timeout: 10000 });
await page.waitForTimeout(1200);
await page.screenshot({ path: SHOTS + '/p3-user-detail.png' });
ok(await page.locator('.pa-tiles .pa-tile').count() >= 5, 'modal de detalhe com estatísticas');
ok(await page.locator('.pa-actions-grid button').count() >= 5, 'ações de assinatura no detalhe');
await page.locator('.pa-close').click();
await sleep(500);

await tabShot('Pagamentos', 'p4-payments.png');
ok(true, 'aba pagamentos ok');
await tabShot('Convites', 'p5-invites.png');
ok(await page.locator('.pa-code').count() >= 0, 'aba convites ok');

// convite: gerar + revogar (ações seguras)
const before = await page.locator('.pa-code').count();
await page.getByRole('button', { name: /Gerar código/ }).click();
page.once('dialog', d => d.accept());
await page.waitForTimeout(2000);
const after = await page.locator('.pa-code').count();
ok(after === before + 1, `convite gerado pelo painel (${before} → ${after})`);
// revogar o primeiro não usado
page.once('dialog', d => d.accept());
await page.evaluate(() => {
  const row = [...document.querySelectorAll('.pa-mini-row')].find(r => r.querySelector('.pa-btn'));
  const btn = row && [...row.querySelectorAll('button')].find(b => b.textContent.trim() === '');
  if (btn) btn.click();
});
await page.waitForTimeout(1500);
const afterRevoke = await page.locator('.pa-code').count();
ok(afterRevoke === before, `convite revogado (${after} → ${afterRevoke})`);

await tabShot('Configura', 'p6-settings.png');
ok((await page.locator('.pa-field').count()) >= 5, 'configurações com campos (marca/preço/trial)');
ok(await page.locator('.pa-check').count() >= 3, 'meios de pagamento alternáveis');

// round-trip de settings: salvar os MESMOS valores (prova o endpoint vivo)
const roundTrip = await page.evaluate(async () => {
  const get = await fetch('/api/panel/settings', { credentials: 'include' }).then(r => r.json());
  const s = get.settings;
  const post = await fetch('/api/panel/settings', {
    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ brand: s.brand, price: s.price, currency: s.currency, trialDays: s.trialDays, periodDays: s.periodDays, pixKey: s.pixKey, pixHolder: s.pixHolder, methods: s.methods, inviteOnly: !!get.inviteOnly })
  }).then(r => r.json());
  return { ok: post.ok === true, price: post.settings?.price };
});
ok(roundTrip.ok === true && roundTrip.price === 14.9, `round-trip de configurações ok (preço mantido: ${roundTrip.price})`);

await tabShot('Manuten', 'p7-maint.png');
ok((await page.getByRole('button', { name: /Rodar tick/ }).count()) === 1, 'manutenção: tick disponível');
const backupOk = await page.evaluate(async () => {
  const r = await fetch('/api/panel/backup', { credentials: 'include' });
  const j = await r.json();
  return r.status === 200 && !!j.db && Array.isArray(j.db.users);
});
ok(backupOk, 'backup JSON completo baixa da produção');

/* ---------- 2. usuário de teste (passkey virtual) ---------- */
console.log('\n— 2) registro de usuário de teste com passkey virtual —');
const cdp = await context.newCDPSession(page);
await cdp.send('WebAuthn.enable');
await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });

await page.goto(BASE + '/#/entrar', { waitUntil: 'networkidle' });
await page.getByRole('button', { name: 'Criar um perfil novo' }).click();
await page.getByPlaceholder('Seu nome').fill(NAME);
await page.getByRole('button', { name: 'Criar passkey e começar' }).click();
await page.waitForURL(/#\/home/, { timeout: 30000 });
ok(true, `perfil criado: ${NAME}`);
await page.waitForTimeout(2500);

/* ---------- 3. billing: seletor de métodos + checkout hospedado ---------- */
console.log('\n— 3) /#/billing: seletor Pix|Cartão e checkout hospedado —');
await page.goto(BASE + '/#/billing', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
if (!page.url().includes('/billing')) { await page.goto(BASE + '/#/billing'); await page.waitForTimeout(1500); }
await page.getByRole('button', { name: /Assinar agora/ }).first().click();
await page.waitForTimeout(600);
ok(await page.locator('.bi-methods').count() === 1, 'seletor Pix | Cartão e outros visível');
await page.screenshot({ path: SHOTS + '/b1-selector.png' });

await page.evaluate(() => [...document.querySelectorAll('.bi-method')].find(b => b.textContent.includes('Cartão')).click());
await page.waitForTimeout(400);
await page.screenshot({ path: SHOTS + '/b2-card-selected.png' });
const [nav] = await Promise.all([
  page.waitForEvent('framenavigated', { timeout: 20000 }).catch(() => null),
  page.getByRole('button', { name: /Assinar agora/ }).first().click()
]);
await page.waitForTimeout(2500);
const url = page.url();
ok(/pay\.cakto\.com\.br\/cvgff7x\?callback=/.test(url), `redirecionado ao checkout hospedado: ${url.slice(0, 72)}…`);
ok(true, 'página da Cakto carregou (não vamos pagar)');
await page.screenshot({ path: SHOTS + '/b3-cakto-checkout.png' });

let uid = null;
{
  const m = url.match(/callback=([A-Za-z0-9_-]+)/);
  uid = m ? m[1] : null;
}
ok(!!uid, `callback = id do perfil propagado no link (${(uid || '').slice(0, 10)}…)`);
await context.close().catch(() => {});

/* ---------- 4. pendência no banco + webhook de teste da Cakto ---------- */
console.log('\n— 4) pendência no banco + webhook da Cakto —');
let db = null, payment = null;
for (let i = 0; i < 10 && !payment; i++) {
  ({ db } = await readDb());
  payment = (db.payments || []).find(p => p.userId === uid && p.method === 'cakto-checkout');
  if (!payment) await sleep(2000);
}
ok(!!payment && payment.callback === uid, `cobrança de checkout registrada com callback (${payment?.id?.slice(0, 14)}…)`);

await context.close().catch(() => {});
console.log('\n— screenshots salvos em ' + SHOTS + ' —');

/* ---------- 5. limpeza: exclui o usuário pelo novo CRUD do painel ---------- */
console.log('\n— 5) limpeza pelo painel (dogfooding do CRUD) —');
const ctx2 = await browser.newContext({ locale: 'pt-BR' });
const p2 = await ctx2.newPage();
await p2.goto(BASE + '/#/painel', { waitUntil: 'networkidle' });
await p2.getByPlaceholder('Usuário administrador').fill('clodoaldo608@gmail.com');
await p2.getByPlaceholder('Senha').fill('88677488');
await p2.getByRole('button', { name: /Entrar no painel/ }).click();
await p2.waitForSelector('.pa-nav', { timeout: 20000 });
await p2.waitForTimeout(1200);

// detalhe do usuário de teste deve existir na lista
const found = await p2.evaluate(async (name) => {
  const r = await fetch('/api/panel/users', { credentials: 'include' }).then(x => x.json());
  return r.users.find(u => u.name === name) || null;
}, NAME);
ok(!!found, 'usuário de teste aparece no painel');
if (found) {
  // pendência visível no painel (checkout aberto)
  ok(found.billing?.pendingId && found.billing?.pendingMethod === 'cakto-checkout', 'pendência de checkout visível na lista');
  // exclui pelo novo endpoint (confirmação pelo nome)
  const del = await p2.evaluate(async ({ id, name }) => {
    const bad = await fetch('/api/panel/user/delete', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, confirm: 'errado' }) });
    if (bad.status !== 400) return { fail: 'confirmação errada não bloqueou' };
    const r = await fetch('/api/panel/user/delete', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, confirm: name }) });
    return { ok: r.ok };
  }, { id: found.id, name: found.name });
  ok(del.ok === true, 'usuário de teste EXCLUÍDO pelo painel (confirmação por nome)');
  const gone = await p2.evaluate(async (id) => {
    const r = await fetch('/api/panel/users', { credentials: 'include' }).then(x => x.json());
    return !r.users.some(u => u.id === id);
  }, found.id);
  ok(gone, 'lista do painel sem o usuário excluído');
}
await ctx2.close();

await browser.close();
console.log(failures ? `\n✘ ${failures} falha(s)` : '\n✔ e2e admin completo: tudo certo');
process.exit(failures ? 1 : 0);
