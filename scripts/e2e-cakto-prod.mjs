/* E2E de produção: fluxo Cakto real no opengyn.vercel.app.
   1) Registra um usuário de teste com passkey VIRTUAL (CDP WebAuthn);
   2) Abre /#/billing → "Assinar agora" → valida formulário → "Gerar Pix"
      (cria cobrança REAL R$14,90 na Cakto via API pública);
   3) Confere o pagamento pendente no banco (repo de dados no GitHub);
   4) Dispara webhook `purchase_approved` ASSINADO (mesma HMAC da Cakto)
      contra https://opengyn.vercel.app/api/billing/webhook;
   5) Clica "Já paguei — verificar acesso" e espera a assinatura ativar;
   6) Limpa só os registros do usuário de teste (o usuário real fica intacto).
   Uso: node scripts/e2e-cakto-prod.mjs            (NODE_PATH com playwright)  */
import { chromium } from 'playwright';
import crypto from 'node:crypto';
import fs from 'node:fs';

const BASE = 'https://opengyn.vercel.app';
const GH_TOKEN = process.env.GH_TOKEN;
const GH_REPO = 'clodoaldosilva608/opengym-data';
const WHSEC = fs.readFileSync('/tmp/cakto_whsec.txt', 'utf8').trim();
const NAME = 'E2E Cakto ' + crypto.randomBytes(2).toString('hex');
const EMAIL = 'e2e.cakto@teste-opengym.com';
const PHONE = '(11) 91234-5678';
const CPF = '529.982.247-25';
const SHOTS = '/tmp/render-e2e';
fs.mkdirSync(SHOTS, { recursive: true });

let failures = 0;
const ok = (c, label) => { console.log((c ? '  ✔ ' : '  ✘ ') + label); if (!c) failures++; };
const GH = { Authorization: 'Bearer ' + GH_TOKEN, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'opengym-e2e' };

async function readDb() {
  const r = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/data/db?ref=main&t=${Date.now()}`, { headers: GH });
  const j = await r.json();
  return { db: JSON.parse(Buffer.from(j.content, 'base64').toString('utf8')), sha: j.sha };
}
async function writeDb(db, sha) {
  const r = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/data/db`, {
    method: 'PUT', headers: GH,
    body: JSON.stringify({ message: 'e2e cakto: atualização do db', content: Buffer.from(JSON.stringify(db)).toString('base64'), sha, branch: 'main' })
  });
  if (!r.ok) throw new Error('writeDb HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return (await r.json()).content.sha;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- limpeza prévia: remove resíduo de um e2e anterior ---------- */
let { db, sha } = await readDb();
const uidOld = (db.users || []).find(u => (u.name || '').startsWith('E2E Cakto'))?.id;
if (uidOld) {
  db.users = db.users.filter(u => u.id !== uidOld);
  db.payments = (db.payments || []).filter(p => p.userId !== uidOld);
  sha = await writeDb(db, sha);
  try {
    const r = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/data/state-${uidOld}`, { headers: GH });
    if (r.ok) await fetch(`https://api.github.com/repos/${GH_REPO}/contents/data/state-${uidOld}`, { method: 'DELETE', headers: GH, body: JSON.stringify({ message: 'e2e cleanup', sha: (await r.json()).sha, branch: 'main' }) });
  } catch { /* */ }
  console.log('resíduo anterior removido:', uidOld);
}

/* ---------- 1. registro com passkey virtual ---------- */
console.log('\n— 1) registro do usuário de teste (passkey virtual) —');
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send('WebAuthn.enable');
await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });

await page.goto(BASE + '/#/entrar', { waitUntil: 'networkidle' });
await page.getByRole('button', { name: 'Criar um perfil novo' }).click();
await page.getByPlaceholder('Seu nome').fill(NAME);
await page.getByRole('button', { name: 'Criar passkey e começar' }).click();
await page.waitForURL(/#\/home/, { timeout: 30000 });
ok(true, `perfil criado: ${NAME}`);
await page.screenshot({ path: SHOTS + '/e2e-01-home.png' });
// afterAuth termina de forma assíncrona (pullState → navigate('/home')): espera assentar
// antes de navegar, senão o navigate tardio desmonta a tela de billing durante o clique.
await page.waitForTimeout(2500);

/* ---------- 2. checkout Cakto no app ---------- */
console.log('\n— 2) checkout: /#/billing → Gerar Pix —');
await page.goto(BASE + '/#/billing', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
if (!page.url().includes('/billing')) {          // corrida residual: tenta de novo
  await page.goto(BASE + '/#/billing');
  await page.waitForTimeout(1200);
}
ok(page.url().includes('/billing'), 'tela de assinatura aberta (' + page.url() + ')');
await page.getByRole('button', { name: /Assinar agora/ }).click();
await page.getByPlaceholder('voce@email.com').fill(EMAIL);
await page.getByPlaceholder('(11) 91234-5678').fill(PHONE);
await page.getByPlaceholder('000.000.000-00').fill(CPF);
await page.getByRole('button', { name: /Gerar Pix/ }).click();
await page.waitForSelector('.bi-qrcode-img', { timeout: 30000 });
ok(true, 'QR Code do Pix renderizado na tela');
const brcodeShown = await page.locator('.bi-brcode').innerText();
ok(brcodeShown.startsWith('000201'), 'BR Code copia-e-cola visível (' + brcodeShown.slice(0, 24) + '…)');
await page.screenshot({ path: SHOTS + '/e2e-02-pix-qr.png' });

/* ---------- 3. pagamento pendente no banco ---------- */
console.log('\n— 3) pagamento pendente no banco de produção —');
let payment = null, userId = null;
for (let i = 0; i < 10 && !payment; i++) {
  ({ db, sha } = await readDb());
  userId = (db.users || []).find(u => u.name === NAME)?.id;
  payment = (db.payments || []).find(p => p.userId === userId && p.method === 'cakto');
  if (!payment) await sleep(2000);
}
ok(!!payment, `registro de pagamento criado (${payment?.id?.slice(0, 14)}…, method=cakto, status=${payment?.status})`);
ok(!!payment?.caktoId, `ordem na Cakto vinculada: caktoId=${payment?.caktoId} refId=${payment?.caktoRefId}`);
ok(!!userId && userId !== '3uGKfvBwf426bmyM', `usuário de teste: ${userId} (usuário real intacto)`);
ok((db.users || []).find(u => u.id === '3uGKfvBwf426bmyM') != null, 'usuário real 3uGKfvBwf426bmyM continua no banco');

/* ---------- 4. webhook assinado ---------- */
console.log('\n— 4) webhook purchase_approved assinado (HMAC como a Cakto envia) —');
const body = {
  secret: WHSEC, event: 'purchase_approved',
  data: {
    id: payment.caktoId, refId: payment.refId, status: 'paid', offer_type: 'main',
    amount: 14.9, baseAmount: 14.9, currency: 'BRL', fees: 1.42, discount: '0.00',
    installments: 1, paymentMethod: 'pix', paymentMethodName: 'Pix',
    customer: { name: NAME, email: EMAIL, phone: '5511912345678', docType: 'cpf', docNumber: '52998224725' },
    product: { id: '6f481978-fe76-4834-a494-4f0f30223497', short_id: '7hwmFov', name: 'openGym — Plano Mensal', type: 'unique' },
    offer: { id: 'cvgff7x', name: 'openGym — Plano Mensal', price: 14.9, currency: 'BRL' },
    subscription: null, createdAt: new Date().toISOString(), paidAt: new Date().toISOString()
  }
};
const raw = JSON.stringify(body);
const ts = String(Math.floor(Date.now() / 1000));
const sig = crypto.createHmac('sha256', WHSEC).update(ts + '.' + raw).digest('hex');
const wh = await fetch(BASE + '/api/billing/webhook', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Cakto-Timestamp': ts, 'X-Cakto-Signature': 'v1=' + sig }, body: raw
});
const whj = await wh.json().catch(() => ({}));
ok(wh.status === 200 && whj.ok === true && whj.outcome === 'approved', `webhook aceito → outcome=${whj.outcome}`);

/* ---------- 5. "Já paguei — verificar acesso" no app ---------- */
console.log('\n— 5) verificação do acesso no app —');
await page.getByRole('button', { name: /Já paguei/ }).click();
await page.waitForURL(/#\/home/, { timeout: 20000 });
ok(true, 'gate liberado — usuário voltou ao app (assinatura ativa)');
await page.screenshot({ path: SHOTS + '/e2e-03-liberado.png' });

/* ---------- 6. estado no banco + limpeza ---------- */
console.log('\n— 6) estado final + limpeza —');
({ db } = await readDb());
const me = (db.users || []).find(u => u.id === userId);
ok(me?.billing?.status === 'active', `billing do teste: status=${me?.billing?.status}, até ${me?.billing?.periodEnd?.slice(0, 10)}`);
ok(me?.email === EMAIL.toLowerCase() && me?.docNumber === '52998224725', 'e-mail/telefone/CPF do pagador gravados no perfil');
const payFinal = (db.payments || []).find(p => p.id === payment.id);
ok(payFinal?.status === 'approved' && payFinal?.approvedBy === 'cakto', `pagamento: ${payFinal?.status} por ${payFinal?.approvedBy}`);

// remove o usuário de teste e os pagamentos dele; o resto fica exatamente como estava
({ sha } = await readDb());
db.users = db.users.filter(u => u.id !== userId);
db.payments = (db.payments || []).filter(p => p.userId !== userId);
await writeDb(db, sha);
try {
  const r = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/data/state-${userId}`, { headers: GH });
  if (r.ok) await fetch(`https://api.github.com/repos/${GH_REPO}/contents/data/state-${userId}`, { method: 'DELETE', headers: GH, body: JSON.stringify({ message: 'e2e cleanup', sha: (await r.json()).sha, branch: 'main' }) });
} catch { /* */ }
ok(true, 'limpeza: usuário de teste e pagamentos removidos do banco');

await browser.close();
console.log(`\n${failures ? '✘ ' + failures + ' falha(s)' : '✔ e2e produção completo: tudo certo'} — screenshots em ${SHOTS}`);
process.exit(failures ? 1 : 0);
