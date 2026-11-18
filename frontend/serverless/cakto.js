/* cakto.js — cliente da API pública do Cakto (docs.cakto.com.br) para o openGym.
   Responsável por:
     - OAuth2: token via POST /public_api/token/ com cache em memória (10 h);
     - Criação de cobrança Pix: POST /public_api/payments/ com X-Idempotency-Key;
     - Validação de webhook: HMAC-SHA256 sobre "{timestamp}.{rawBody}" com o
       segredo do webhook (headers X-Cakto-Timestamp / X-Cakto-Signature: v1=),
       com tolerância de 5 min — e o fallback "secret" no corpo, descrito na doc;
     - Normalização de telefone/CPF do pagador.
   Env vars: CAKTO_CLIENT_ID, CAKTO_CLIENT_SECRET, CAKTO_OFFER_ID,
   CAKTO_WEBHOOK_SECRET, CAKTO_PIX_EXPIRES_IN (s, default 3600), CAKTO_BASE_URL.
   Sem dependências: fetch global + node:crypto. Env lido sob demanda (lazy) para
   ser importável em testes sem ambiente configurado. */
import crypto from 'node:crypto';

const BASE = () => String(process.env.CAKTO_BASE_URL || 'https://api.cakto.com.br/public_api/').replace(/\/?$/, '/');
const env = k => String(process.env[k] || '').trim();
export const PIX_EXPIRES_IN = () => Math.max(60, +(process.env.CAKTO_PIX_EXPIRES_IN || 3600) || 3600);

/* Oferta configurada no painel (items[].offerId). O preço da oferta é a fonte
   do valor cobrado — o servidor confere contra PRICE antes de cobrar. */
export function offerId() { return env('CAKTO_OFFER_ID'); }
export function isConfigured() { return !!(env('CAKTO_CLIENT_ID') && env('CAKTO_CLIENT_SECRET') && offerId()); }
export function hasWebhookSecret() { return !!env('CAKTO_WEBHOOK_SECRET'); }

/* Checkout hospedado da oferta — página da Cakto que aceita todos os meios
   habilitados no produto (cartão, PicPay, Google Pay, Apple Pay, card+pix…).
   Docs: o link público é https://pay.cakto.com.br/{id_da_oferta}. O parâmetro
   `callback` (identificador opaco nosso) volta no webhook purchase_approved
   para conciliar compras feitas nesse checkout. CAKTO_CHECKOUT_URL sobrescreve
   (útil para mocks de teste). */
export function hostedCheckoutUrl() {
  const custom = env('CAKTO_CHECKOUT_URL');
  if (custom) return String(custom).replace(/\/?$/, '');
  const o = offerId();
  return o ? 'https://pay.cakto.com.br/' + encodeURIComponent(o) : null;
}

/* ------------------------------ OAuth2 ------------------------------ */
/* Token em memória por instância; renova 5 min antes de expirar. Não existe
   refresh token na doc — pedimos um novo quando perto do fim da vida. */
let tok = null;
export async function accessToken() {
  const cid = env('CAKTO_CLIENT_ID'), csec = env('CAKTO_CLIENT_SECRET');
  if (!cid || !csec) throw new Error('cakto: credenciais não configuradas (CAKTO_CLIENT_ID / CAKTO_CLIENT_SECRET)');
  if (tok && tok.exp > Date.now() + 5 * 60000) return tok.token;
  const r = await fetch(BASE() + 'token/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: cid, client_secret: csec })
  });
  if (!r.ok) throw new Error('cakto: falha de autenticação (HTTP ' + r.status + ')');
  const j = await r.json().catch(() => ({}));
  if (!j.access_token) throw new Error('cakto: token ausente na resposta de autenticação');
  tok = { token: String(j.access_token), exp: Date.now() + Math.max(60, +j.expires_in || 36000) * 1000 };
  return tok.token;
}

/* --------------------------- criar cobrança Pix ---------------------------
   Docs: POST /public_api/payments/ — 1 item (oferta), customer com name/email/
   phone (E.164)/fingerprint obrigatórios; docType+docNumber recomendados para
   produtores brasileiros (nota fiscal). Retorna id/refId/checkoutUrl e
   pix.qrCode (BR Code copia-e-cola — a imagem QR é gerada no app).            */
export async function createPixCharge({ customer, idempotencyKey, expiresIn, sck }) {
  const token = await accessToken();
  const body = {
    paymentMethod: 'pix',
    customer: {
      name: String(customer.name).slice(0, 255),
      email: String(customer.email).slice(0, 254),
      phone: customer.phone,
      fingerprint: String(customer.fingerprint || 'opengym').slice(0, 255),
      docType: customer.docType || 'cpf',
      docNumber: onlyDigits(customer.docNumber)
    },
    items: [{ offerId: offerId(), quantity: 1, offerType: 'main' }],
    pixExpiresIn: expiresIn || PIX_EXPIRES_IN(),
    metadata: { sck: String(sck || '').slice(0, 255) }
  };
  const r = await fetch(BASE() + 'payments/', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': idempotencyKey || crypto.randomUUID()
    },
    body: JSON.stringify(body)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const first = v => (Array.isArray(v) ? v[0] : v);
    const detail = first(j.detail || (j.items && j.items[0]) || (j.customer && (j.customer.email || j.customer.phone || j.customer.docNumber)) || j.paymentMethod) ||
      first(Object.values(j)[0]) || '';
    const msg = 'cakto: cobrança recusada (HTTP ' + r.status + (detail ? ' — ' + detail : '') + ')';
    const e = new Error(msg);
    e.status = r.status;
    throw e;
  }
  return normalizeCharge(j);
}

/* Formato comum do registro em db.payments (method 'cakto'). */
export function normalizeCharge(j) {
  return {
    caktoId: j.id || null,
    caktoRefId: j.refId || null,
    caktoStatus: j.status || 'waiting_payment',
    amount: Number(j.amount ?? 0),
    currency: 'BRL',
    checkoutUrl: j.checkoutUrl || null,
    qrCode: j.pix?.qrCode || null,
    qrExpiresAt: j.pix?.expirationDate || null,
    createdAt: j.createdAt || new Date().toISOString()
  };
}

/* Consulta de pedido (conciliação manual no painel). */
export async function fetchOrder(orderId) {
  const token = await accessToken();
  const r = await fetch(BASE() + 'orders/' + encodeURIComponent(orderId) + '/', { headers: { 'Authorization': 'Bearer ' + token } });
  if (!r.ok) throw new Error('cakto: pedido não encontrado (HTTP ' + r.status + ')');
  return r.json();
}

/* -------------------------- webhook: validação ---------------------------
   Header (recomendado): X-Cakto-Timestamp (unix seg) + X-Cakto-Signature
   "v1=<hex>", HMAC-SHA256 do segredo sobre "{timestamp}.{rawBody}". Janela de
   5 min. Corpo (fallback da doc): campo "secret" igual ao segredo.           */
export function verifyWebhook(rawBody, timestamp, signature, toleranceMs = 5 * 60000) {
  const secret = env('CAKTO_WEBHOOK_SECRET');
  if (!secret) return { ok: false, reason: 'servidor sem CAKTO_WEBHOOK_SECRET' };
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts * 1000) > toleranceMs) return { ok: false, reason: 'timestamp fora da janela de tolerância' };
  const clean = String(signature || '').trim().replace(/^v1=/, '');
  if (!/^[0-9a-f]{64}$/i.test(clean)) return { ok: false, reason: 'assinatura ausente ou malformada' };
  const expect = crypto.createHmac('sha256', secret).update(String(timestamp) + '.' + String(rawBody)).digest('hex');
  try {
    if (!crypto.timingSafeEqual(Buffer.from(clean.toLowerCase(), 'hex'), Buffer.from(expect, 'hex')))
      return { ok: false, reason: 'assinatura inválida' };
  } catch { return { ok: false, reason: 'assinatura inválida' }; }
  return { ok: true };
}

export function bodySecretMatches(body) {
  const secret = env('CAKTO_WEBHOOK_SECRET');
  return !!secret && String(body?.secret || '') === secret;
}

/* ----------------------- dados do pagador (BR) --------------------------- */
export const onlyDigits = s => String(s || '').replace(/\D/g, '');

/* Telefone → E.164 Brasil (55 + DDD + 8/9 dígitos). Aceita "(11) 91234-5678",
   "5511912345678", "+55 11 91234-5678". Celular começa com 9; fixo com 2-5.
   Devolve null se impossível. */
export function normalizePhone(phone) {
  let d = onlyDigits(phone);
  if (d.startsWith('0')) d = d.slice(1);
  if (!d.startsWith('55')) d = '55' + d;
  const rest = d.slice(2);                                     // DDD (2) + número (8/9)
  if (rest.length === 11 && rest[0] >= '1' && rest[2] === '9') return d;                              // celular: 9º dígito
  if (rest.length === 10 && rest[0] >= '1' && rest[2] >= '2' && rest[2] <= '5') return d;              // fixo: 2-5
  return null;
}

/* CPF: 11 dígitos com dígitos verificadores válidos (inclusive "todos iguais"). */
export function validCPF(cpf) {
  const c = onlyDigits(cpf);
  if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return false;
  const digit = n => {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += +c[i] * (n + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return digit(9) === +c[9] && digit(10) === +c[10];
}

/* E-mail simples (o Cakto exige e-mail do pagador; é também nossa chave de
   conciliação do webhook). */
export const validEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(s || '').trim());
