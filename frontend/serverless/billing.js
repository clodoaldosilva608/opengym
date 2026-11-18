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
import { isConfigured as caktoConfigured } from './cakto.js';

export const PERIOD_DAYS = Math.max(1, +(process.env.PERIOD_DAYS || 30) || 30);
export const TRIAL_DAYS = Math.max(0, +(process.env.TRIAL_DAYS ?? 7) || 7);
export const PRICE = (() => {
  const p = +(process.env.PRICE_MONTHLY ?? 14.9);
  return Number.isFinite(p) && p > 0 ? Math.round(p * 100) / 100 : 14.9;
})();
export const CURRENCY = (process.env.PRICE_CURRENCY || 'BRL').toUpperCase();
export const BRAND = (process.env.APP_BRAND || 'openGym').slice(0, 40);
export const PIX_KEY = (process.env.PIX_KEY || '').trim();
export const PIX_HOLDER = (process.env.PIX_HOLDER || '').trim();
export const MP_TOKEN = (process.env.MERCADOPAGO_ACCESS_TOKEN || '').trim();
export const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || '').trim();
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
export const ADMIN_SESSION_DAYS = Math.max(1, +(process.env.ADMIN_SESSION_DAYS || 2) || 2);
// Quem pode assinar: 'all' (padrão) ou 'invite' (só quem entrou com convite — usa o fluxo existente)
// Prioridade: Cakto (Pix automático via webhook) > Mercado Pago > Pix manual > nenhum.
export const CHECKOUT_METHOD = caktoConfigured() ? 'cakto' : MP_TOKEN ? 'mp' : (PIX_KEY ? 'pix' : 'none');

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
  return {
    brand: BRAND, price: PRICE, currency: CURRENCY, trialDays: TRIAL_DAYS,
    method: CHECKOUT_METHOD, pix: PIX_KEY ? { key: PIX_KEY, holder: PIX_HOLDER } : null
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
