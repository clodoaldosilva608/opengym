/* billing.js — assinaturas, pagamentos e autenticação do painel admin.
   Módulo puro (funções recebem db/opções) para ser testável com node --test
   sem bootar o servidor. Estado vive no mesmo db.json do app:
     user.billing = { status, free, trialEndsAt, periodEnd, grandfathered, note }
     db.payments  = [{ id, userId, amount, method, status, createdAt, ... }]
     db.admins    = [{ id, username, salt, hash, created }]
   Fluxos de pagamento:
     'cakto' — Cakto (docs.cakto.com.br): cria cobrança Pix pela API pública;
               o webhook /api/billing/webhook valida a assinatura HMAC e aprova
               sozinho (sem intervenção do admin). Cliente em cakto.js.
     'pix'   — manual: mostra a chave Pix, o usuário avisa, o admin aprova no painel.
     'mp'    — Mercado Pago: cria preferência de checkout; o mesmo webhook
               despacha por forma de pagamento.                             */
import crypto from 'node:crypto';
import { isConfigured as caktoConfigured, hostedCheckoutUrl } from './cakto.js';

/* Valores padrão vindos do ambiente — o painel admin pode sobrescrever via
   db.settings (applySettings). Exportados com `let` de propósito: as bindings
   vivas do ESM fazem o importador ver o valor atualizado depois do apply. */
const ENV = {
  PERIOD_DAYS: Math.max(1, +(process.env.PERIOD_DAYS || 30) || 30),
  TRIAL_DAYS: Math.max(0, +(process.env.TRIAL_DAYS ?? 7) || 7),
  PRICE: (() => {
    const p = +(process.env.PRICE_MONTHLY ?? 14.9);
    return Number.isFinite(p) && p > 0 ? Math.round(p * 100) / 100 : 14.9;
  })(),
  CURRENCY: (process.env.PRICE_CURRENCY || 'BRL').toUpperCase(),
  BRAND: (process.env.APP_BRAND || 'openGym').slice(0, 40),
  PIX_KEY: (process.env.PIX_KEY || '').trim(),
  PIX_HOLDER: (process.env.PIX_HOLDER || '').trim()
};
export let PERIOD_DAYS = ENV.PERIOD_DAYS;
export let TRIAL_DAYS = ENV.TRIAL_DAYS;
export let PRICE = ENV.PRICE;
export let CURRENCY = ENV.CURRENCY;
export let BRAND = ENV.BRAND;
export let PIX_KEY = ENV.PIX_KEY;
export let PIX_HOLDER = ENV.PIX_HOLDER;
export const MP_TOKEN = (process.env.MERCADOPAGO_ACCESS_TOKEN || '').trim();
export const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || '').trim();
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
export const ADMIN_SESSION_DAYS = Math.max(1, +(process.env.ADMIN_SESSION_DAYS || 2) || 2);

/* -------- configurações editáveis no painel (db.settings) ----------------
   Tudo opcional: campo ausente = valor do ambiente. `methods` só tem efeito
   quando o Cakto está configurado (liga/desliga Pix inline e checkout
   hospedado — cartão, PicPay, Google Pay, Apple Pay…). inviteOnly null =
   segue a env INVITE_ONLY. */
export const settings = { inviteOnly: null };
const clamp = (v, min, max, dflt) => {
  const n = Math.round(+v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};
const r2 = v => Math.round(v * 100) / 100;
export function applySettings(s = {}) {
  Object.assign(settings, {
    price: Number.isFinite(+s.price) && +s.price > 0 ? r2(+s.price) : null,
    currency: /^[a-z]{3}$/i.test(String(s.currency || '')) ? String(s.currency).toUpperCase() : null,
    brand: s.brand != null && String(s.brand).trim() ? String(s.brand).trim().slice(0, 40) : null,
    trialDays: s.trialDays != null ? clamp(s.trialDays, 0, 365, null) : null,
    periodDays: s.periodDays != null ? clamp(s.periodDays, 1, 3650, null) : null,
    pixKey: s.pixKey != null ? String(s.pixKey).trim().slice(0, 120) : null,
    pixHolder: s.pixHolder != null ? String(s.pixHolder).trim().slice(0, 80) : null,
    methods: s.methods && typeof s.methods === 'object'
      ? { pix: s.methods.pix !== false, checkout: s.methods.checkout !== false }
      : null,
    inviteOnly: s.inviteOnly == null ? null : !!s.inviteOnly
  });
  PRICE = settings.price ?? ENV.PRICE;
  CURRENCY = settings.currency ?? ENV.CURRENCY;
  BRAND = settings.brand ?? ENV.BRAND;
  TRIAL_DAYS = settings.trialDays ?? ENV.TRIAL_DAYS;
  PERIOD_DAYS = settings.periodDays ?? ENV.PERIOD_DAYS;
  PIX_KEY = settings.pixKey ?? ENV.PIX_KEY;
  PIX_HOLDER = settings.pixHolder ?? ENV.PIX_HOLDER;
}
/* Valores efetivos para o painel (com os padrões já resolvidos). */
export function effectiveSettings() {
  return {
    brand: BRAND, price: PRICE, currency: CURRENCY,
    trialDays: TRIAL_DAYS, periodDays: PERIOD_DAYS,
    pixKey: PIX_KEY, pixHolder: PIX_HOLDER,
    methods: settings.methods || { pix: true, checkout: true },
    inviteOnly: settings.inviteOnly
  };
}

// Prioridade: Cakto (webhook aprova sozinho) > Mercado Pago > Pix manual > nenhum.
export const checkoutMethod = () => caktoConfigured() ? 'cakto' : MP_TOKEN ? 'mp' : (PIX_KEY ? 'pix' : 'none');
// Métodos disponíveis para o usuário escolher no /#/billing:
export function availableMethods() {
  const m = checkoutMethod();
  if (m === 'cakto') {
    const cfg = settings.methods || { pix: true, checkout: true };
    return { pix: cfg.pix !== false, checkout: cfg.checkout !== false };
  }
  if (m === 'mp') return { mp: true };
  if (m === 'pix') return { pix: true };       // Pix manual (chave + aprovação do admin)
  return {};
}

/* ------------------------------ status ------------------------------ */
// Fonte única de verdade do acesso. Códigos:
//   free    — isento (dono/amigo, concedido pelo painel)
//   active  — assinatura paga, período corrente válido
//   trial   — dentro do período de avaliação
//   overdue — sem acesso (trial vencido ou assinatura parou)
export function billingStatus(user, now = Date.now()) {
  const b = user && user.billing ? user.billing : {};
  if (b.free) return { code: 'free', periodEnd: b.periodEnd || null };
  const tEnd = b.trialEndsAt ? +new Date(b.trialEndsAt) : 0;
  if (b.status === 'active' && b.periodEnd && +new Date(b.periodEnd) > now)
    return { code: 'active', periodEnd: b.periodEnd };
  if (b.status === 'trial' && tEnd > now) return { code: 'trial', trialEndsAt: b.trialEndsAt };
  return {
    code: 'overdue',
    trialEndsAt: tEnd > 0 ? b.trialEndsAt : null,
    periodEnd: b.periodEnd || null
  };
}
export const hasAccess = (user, now = Date.now()) => billingStatus(user, now).code !== 'overdue';

/* ---------------------------- migrações ----------------------------- */
// Perfis criados antes do faturamento existir = o dono da instância → isentos.
// Novos cadastros começam em trial. Chamado no boot e depois de cada save externo.
export function migrateBilling(db, trialDays = TRIAL_DAYS, now = Date.now()) {
  let changed = 0;
  for (const u of db.users || []) {
    if (!u.billing) {
      u.billing = { status: 'free', free: true, trialEndsAt: null, periodEnd: null, grandfathered: true, note: 'perfil pré-existente — isento' };
      changed++;
    }
  }
  if (!Array.isArray(db.payments)) { db.payments = []; changed++; }
  if (!Array.isArray(db.admins)) { db.admins = []; changed++; }
  return changed;
}
export function newUserBilling(trialDays = TRIAL_DAYS, now = Date.now()) {
  if (trialDays <= 0) return { status: 'overdue', free: false, trialEndsAt: new Date(now).toISOString(), periodEnd: null, grandfathered: false, note: null };
  return { status: 'trial', free: false, trialEndsAt: new Date(now + trialDays * 86400000).toISOString(), periodEnd: null, grandfathered: false, note: null };
}

/* --------------------------- pagamentos ----------------------------- */
export const newId = p => p + '_' + crypto.randomBytes(10).toString('base64url');

export function pendingPayment(db, userId) {
  return (db.payments || []).find(p => p.userId === userId && p.status === 'pending') || null;
}
export function createPayment(db, userId, amount, method, extra = {}, now = Date.now()) {
  const p = { id: newId('pay'), userId, amount, currency: CURRENCY, method, status: 'pending', createdAt: new Date(now).toISOString(), ...extra };
  db.payments.push(p);
  return p;
}
// Aprova um pagamento e estende o período do usuário. Retorna o usuário ou null.
export function approvePayment(db, paymentId, { by = 'sistema', periodDays = PERIOD_DAYS } = {}, now = Date.now()) {
  const p = (db.payments || []).find(x => x.id === paymentId);
  if (!p || p.status !== 'pending') return null;
  const u = (db.users || []).find(x => x.id === p.userId);
  if (!u) return null;
  p.status = 'approved';
  p.approvedAt = new Date(now).toISOString();
  p.approvedBy = by;
  // Renova a partir do fim do período atual (prorroga quem pagou adiantado), nunca do passado.
  const b = u.billing = u.billing || newUserBilling(0, now);
  const base = b.periodEnd && +new Date(b.periodEnd) > now ? +new Date(b.periodEnd) : now;
  b.status = 'active';
  b.periodEnd = new Date(base + periodDays * 86400000).toISOString();
  return u;
}
export function rejectPayment(db, paymentId, { by = 'sistema' } = {}, now = Date.now()) {
  const p = (db.payments || []).find(x => x.id === paymentId);
  if (!p || p.status !== 'pending') return null;
  p.status = 'rejected';
  p.approvedAt = new Date(now).toISOString();
  p.approvedBy = by;
  return p;
}
export function grantFree(user, free, note = null) {
  const b = user.billing = user.billing || newUserBilling(0);
  b.free = !!free;
  b.status = free ? 'free' : (b.status === 'free' ? 'overdue' : b.status);
  b.note = note;
  return b;
}

/* --------------------- painel admin (senha própria) ------------------ */
// Hash scrypt (node:crypto — sem dependências). Separado das passkeys dos usuários
// de propósito: o painel é outra superfície de ataque e não pode herdar sessões do app.
export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}
export function verifyPassword(password, salt, hash) {
  try {
    const cand = crypto.scryptSync(String(password), salt, 64);
    return crypto.timingSafeEqual(Buffer.from(cand), Buffer.from(hash, 'hex'));
  } catch { return false; }
}
// Token de sessão do painel: payload `admin:<id>:<ver>:<exp>`, HMAC com o mesmo SECRET do
// servidor mas cookie distinto (ogadmin) — sair do app não afeta o painel e vice-versa. A
// versão `ver` vive no registro do admin: o logout incrementa e todo token antigo morre,
// mesmo que o cookie tenha sido copiado (diferente do gymsid do app, que só expira).
export function makePanelToken(adminId, SECRET, days = ADMIN_SESSION_DAYS, now = Date.now(), ver = 0) {
  const payload = 'admin:' + adminId + ':' + ver + ':' + (now + days * 86400000);
  const mac = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return payload + '.' + mac;
}
export function readPanelToken(token, SECRET, now = Date.now()) {
  if (!token || typeof token !== 'string') return null;
  const i = token.lastIndexOf('.');
  if (i < 0) return null;
  const payload = token.slice(0, i), mac = token.slice(i + 1);
  try {
    const expect = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
    if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
  } catch { return null; }
  const parts = payload.split(':');
  const [kind, id, ver, exp] = parts;
  if (kind !== 'admin' || !id || !Number.isInteger(+ver) || +exp < now) return null;
  return { adminId: id, ver: +ver };
}
// Rate-limit simples de login do painel (em memória): 10 tentativas / 10 min por username+IP.
export function attemptsKey(ip, username) { return (ip || '?') + '|' + String(username || '').toLowerCase(); }

/* ------------------------- Mercado Pago (opcional) ------------------- */
const MP_API = 'https://api.mercadopago.com';
export async function mpCreatePreference(token, { title, price, currency, externalReference, backUrl, notificationUrl }) {
  const r = await fetch(MP_API + '/checkout/preferences', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items: [{ title, unit_price: price, quantity: 1, currency_id: currency }],
      external_reference: externalReference,
      back_urls: { success: backUrl, pending: backUrl, failure: backUrl },
      ...(notificationUrl ? { notification: notificationUrl } : {})
    })
  });
  if (!r.ok) throw new Error('mercado pago: ' + r.status + ' ' + (await r.text().catch(() => '')));
  const j = await r.json();
  return { id: j.id, initPoint: j.init_point || j.sandbox_init_point || null };
}
export async function mpFetchPayment(token, paymentId) {
  const r = await fetch(MP_API + '/v1/payments/' + encodeURIComponent(paymentId), {
    headers: { 'Authorization': 'Bearer ' + token }
  });
  if (!r.ok) throw new Error('mercado pago: ' + r.status);
  return r.json();
}

/* ------------------------- resposta pública -------------------------- */
// O que o /api/config e o /api/me devolvem sobre faturamento — sem nada sensível.
export function publicBilling() {
  const methods = availableMethods();
  return {
    brand: BRAND, price: PRICE, currency: CURRENCY, trialDays: TRIAL_DAYS,
    method: checkoutMethod(),
    methods,                                                        // {pix,checkout} | {mp} | {pix} | {}
    checkoutUrl: methods.checkout ? hostedCheckoutUrl() : null,     // checkout hospedado Cakto (cartão/PicPay/GPay/ApplePay)
    pix: PIX_KEY ? { key: PIX_KEY, holder: PIX_HOLDER } : null
  };
}
// Registro de pagamento seguro para devolver ao frontend (nunca vazar
// credenciais; dados de Pix são públicos por natureza).
export function publicPayment(p) {
  if (!p) return null;
  return {
    id: p.id, caktoId: p.caktoId || null, amount: p.amount, currency: p.currency, method: p.method,
    status: p.status, createdAt: p.createdAt, approvedAt: p.approvedAt || null,
    checkoutUrl: p.checkoutUrl || null, qrCode: p.qrCode || null,
    qrExpiresAt: p.qrExpiresAt || null, refId: p.caktoRefId || null
  };
}
// Resumo para /api/me e /api/billing/status — `pendingPayment` precisa do db real, por
// isso o caller (server.js) injeta o sinal `pending` por cima deste objeto.
export function meBilling(user, now = Date.now()) {
  return billingStatus(user, now);
}
