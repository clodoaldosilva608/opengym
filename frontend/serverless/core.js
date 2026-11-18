/* core.js — handler serverless da API do openGym (edição hospedagem gratuita).
   Porta do api/server.js para funções Node da Vercel, sem servidor dedicado:

   - Sem disco persistente: db.json, estados por usuário, desafios WebAuthn,
     timers e segredo de sessão vivem na camada storage.js (repo privado GitHub
     em produção, disco em dev).
   - Sem processos de longa duração: os timers em memória (lembrete diário e
     descanso) viram um "tick" cooperativo disparado a cada requisição (throttle
     20s) e por GET /api/cron/tick (Vercel Cron diário + Actions do GitHub a cada
     5 min). Precisão: lembretes ±5 min; timer de descanso dispara no próximo tick.
   - AI Coach (spawna CLIs locais) não existe serverless: /api/coach/* e
     /api/admin/coach/* respondem 503 com mensagem clara.
   - Presence continua em memória por instância (feature efêmera, best-effort).

   export default handler(req, res) — mesma assinatura do http.createServer.  */
import crypto from 'node:crypto';
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse
} from '@simplewebauthn/server';
import webpush from 'web-push';
import * as billing from './billing.js';
import * as store from './storage.js';

const RP_ID = process.env.RP_ID || 'localhost';
const ORIGIN = process.env.ORIGIN || 'http://localhost:8080';
const RP_NAME = process.env.RP_NAME || 'openGym';
const ADMIN_UIDS = (process.env.ADMIN_UIDS || '').split(',').map(s => s.trim()).filter(Boolean);
const INVITE_ONLY = /^(1|true|yes|on)$/i.test(process.env.INVITE_ONLY || '');
const SESSION_DAYS = Math.max(1, +(process.env.SESSION_DAYS || 90) || 90);
const MAX_BODY = 5 * 1024 * 1024;
const SECURE = /^https:/i.test(ORIGIN) ? ' Secure;' : '';
const CRON_SECRET = (process.env.CRON_SECRET || '').trim();
// frescor do db em memória: entre instâncias o revalidate é conditional GET
// (304 não consome rate limit), então 2s é o pior caso de estagnação visível
const DB_TTL = 2000;

/* ---------- helpers ---------- */
function json(res, code, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(extraHeaders || {}) });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', d => {
      size += d.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(d);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}
const b64uToBuf = s => Buffer.from(s, 'base64url');

/* ---------- init: segredo + vapid (lazy, 1× por instância) ---------- */
let SECRET = (process.env.SECRET || '').trim() || null;
let vapid = null;
let initPromise = null;
async function ensureSecret() {
  if (SECRET) return SECRET;
  let s = await store.readText('secret');
  if (!s) { s = crypto.randomBytes(32).toString('hex'); await store.writeText('secret', s); }
  SECRET = String(s).trim();
  return SECRET;
}
async function ensureVapid() {
  if (vapid) return vapid;
  vapid = await store.readJson('vapid', null);
  if (!vapid?.publicKey || !vapid?.privateKey) {
    vapid = webpush.generateVAPIDKeys();
    await store.writeJson('vapid', vapid);
  }
  const subject = process.env.VAPID_SUBJECT || (/^https:/i.test(ORIGIN) ? ORIGIN : 'mailto:admin@localhost');
  webpush.setVapidDetails(subject, vapid.publicKey, vapid.privateKey);
  return vapid;
}
function init() {
  if (!initPromise) initPromise = Promise.all([ensureSecret(), ensureVapid()]).then(() => {});
  return initPromise;
}

/* ---------- db (carregado do storage, frescor por TTL) ---------- */
let db = null, dbAt = 0, dbLoading = null;
async function loadDb() {
  const loaded = (await store.readJson('db', null)) || { users: [], creds: [], subs: [], invites: [], payments: [], admins: [] };
  loaded.subs = loaded.subs || []; loaded.invites = loaded.invites || [];
  loaded.payments = loaded.payments || []; loaded.admins = loaded.admins || [];
  db = loaded; dbAt = Date.now();
  // migrações idempotentes de billing + bootstrap do painel admin (só grava se mudou)
  let changed = billing.migrateBilling(db);
  if (billing.ADMIN_USERNAME && billing.ADMIN_PASSWORD) {
    const existing = db.admins.find(a => a.username === billing.ADMIN_USERNAME);
    if (!existing) {
      const { salt, hash } = billing.hashPassword(billing.ADMIN_PASSWORD);
      db.admins.push({ id: crypto.randomBytes(8).toString('base64url'), username: billing.ADMIN_USERNAME, salt, hash, created: new Date().toISOString() });
      changed++;
    } else if (!billing.verifyPassword(billing.ADMIN_PASSWORD, existing.salt, existing.hash)) {
      Object.assign(existing, billing.hashPassword(billing.ADMIN_PASSWORD));
      changed++;
    }
  }
  if (changed) await saveDb();
}
async function ensureDb() {
  if (db && Date.now() - dbAt < DB_TTL) return db;
  if (!dbLoading) dbLoading = loadDb().finally(() => { dbLoading = null; });
  await dbLoading;
  return db;
}
async function saveDb() { dbAt = Date.now(); await store.writeJson('db', db); }

/* ---------- estados por usuário (cache curto em memória) ---------- */
const stateCache = new Map();   // uid -> { data, at }
const STATE_TTL = 10000;
const stateName = uid => 'state-' + String(uid).replace(/[^a-zA-Z0-9_-]/g, '');
async function readState(uid) {
  const c = stateCache.get(uid);
  if (c && Date.now() - c.at < STATE_TTL) return c.data;
  const data = await store.readJson(stateName(uid), null);
  stateCache.set(uid, { data, at: Date.now() });
  return data;
}
async function writeState(uid, state) {
  await store.writeJson(stateName(uid), state);
  stateCache.set(uid, { data: state, at: Date.now() });
}

/* ---------- push notifications (Web Push / VAPID) ---------- */
async function sendPush(userId, payload) {
  await ensureDb();
  const subs = db.subs.filter(s => s.userId === userId);
  if (!subs.length) return;
  const body = JSON.stringify(payload);
  let dirty = false;
  await Promise.all(subs.map(async sub => {
    try { await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, body, { urgency: 'high' }); }
    catch (e) {
      console.error('push send failed', userId, e.statusCode, e.body || e.message);
      if (e.statusCode === 404 || e.statusCode === 410) {
        db.subs = db.subs.filter(s => s.endpoint !== sub.endpoint); dirty = true;
      }
    }
  }));
  if (dirty) await saveDb();
}

/* ---------- sessões (cookie assinado com HMAC) ---------- */
function sign(payload) {
  const mac = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return payload + '.' + mac;
}
function verifySig(token) {
  const i = token.lastIndexOf('.');
  if (i < 0) return null;
  const payload = token.slice(0, i), mac = token.slice(i + 1);
  const expect = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  try {
    if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
  } catch { return null; }
  return payload;
}
const sessionVersion = user => user.sv || 0;
function makeSession(user) {
  const exp = Date.now() + SESSION_DAYS * 86400000;
  return sign(user.id + ':' + exp + ':' + sessionVersion(user));
}
function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(c => {
    const i = c.indexOf('='); return i < 0 ? ['', ''] : [c.slice(0, i).trim(), c.slice(i + 1).trim()];
  }));
}
async function readSession(req) {
  await ensureDb();
  const tok = parseCookies(req).gymsid;
  if (!tok) return null;
  const payload = verifySig(tok);
  if (!payload) return null;
  const [uid, exp, ver] = payload.split(':');
  if (!uid || +exp < Date.now()) return null;
  const user = db.users.find(u => u.id === uid) || null;
  if (!user) return null;
  if (user.disabled) return null;
  const claimed = ver === undefined ? 0 : Number(ver);
  if (!Number.isInteger(claimed) || claimed !== sessionVersion(user)) return null;
  return user;
}
const isAdmin = user => !!user && (user.admin === true || ADMIN_UIDS.includes(user.id));
async function requireAdmin(req, res) {
  const user = await readSession(req);
  if (!user) { json(res, 401, { error: 'not signed in' }); return null; }
  if (!isAdmin(user)) { json(res, 403, { error: 'forbidden' }); return null; }
  return user;
}
function sessionCookie(user) {
  return `gymsid=${makeSession(user)}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly;${SECURE} SameSite=Lax`;
}
const clearCookie = `gymsid=; Path=/; Max-Age=0; HttpOnly;${SECURE} SameSite=Lax`;

/* ---------- sessão do painel admin (cookie separado do app) ---------- */
const PANEL_COOKIE = 'ogadmin';
function panelCookie(token) {
  return `${PANEL_COOKIE}=${token}; Path=/; Max-Age=${billing.ADMIN_SESSION_DAYS * 86400}; HttpOnly;${SECURE} SameSite=Lax`;
}
const panelClearCookie = `${PANEL_COOKIE}=; Path=/; Max-Age=0; HttpOnly;${SECURE} SameSite=Lax`;
async function readPanelSession(req) {
  await ensureDb();
  const t = billing.readPanelToken(parseCookies(req)[PANEL_COOKIE], SECRET);
  if (!t) return null;
  const admin = db.admins.find(a => a.id === t.adminId);
  if (!admin) return null;
  if ((admin.pnlSv || 0) !== t.ver) return null;
  return admin;
}
async function requirePanel(req, res) {
  const admin = await readPanelSession(req);
  if (!admin) { json(res, 401, { error: 'sessão do painel expirada' }); return null; }
  return admin;
}

/* ---------- gate de assinatura ---------- */
async function requireAccess(req, res) {
  const user = await readSession(req);
  if (!user) { json(res, 401, { error: 'not signed in' }); return null; }
  if (!billing.hasAccess(user)) {
    json(res, 402, { error: 'subscription required', billing: { ...billing.meBilling(user), pending: !!billing.pendingPayment(db, user.id) } });
    return null;
  }
  return user;
}

/* rate-limit do login do painel (em memória por instância): 10 / 10 min / username+IP */
const panelAttempts = new Map();
function panelRateLimited(key) {
  const now = Date.now();
  let rec = panelAttempts.get(key);
  if (!rec || now > rec.reset) { rec = { n: 0, reset: now + 600000 }; panelAttempts.set(key, rec); }
  rec.n++;
  return rec.n > 10;
}
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket?.remoteAddress || '?';
}

/* ---------- desafios WebAuthn (persistidos no storage, TTL 5 min) ---------- */
async function putChallenge(data) {
  const cid = crypto.randomBytes(16).toString('base64url');
  await store.writeJson('challenge-' + cid, { ...data, exp: Date.now() + 5 * 60000 });
  return cid;
}
async function takeChallenge(cid) {
  if (!cid || /[^\w-]/.test(String(cid))) return null;
  const c = await store.readJson('challenge-' + cid, null);
  if (!c) return null;
  store.remove('challenge-' + cid).catch(() => {});
  if (c.exp < Date.now()) return null;
  return c;
}

/* ---------- presence (efêmera, em memória por instância) ---------- */
const presence = new Map();
const PRESENCE_TTL = 70000;
function livePresence(uid) {
  const p = presence.get(uid);
  if (!p) return null;
  if (Date.now() - p.updatedAt > PRESENCE_TTL) { presence.delete(uid); return null; }
  return p;
}

/* ---------- timers + lembretes (sem processos: tick cooperativo) ---------- */
// timers.json   { uid: fireAt }          — timer de descanso por usuário
// reminders.json { uid: { on, time, tz, lastDate } } — índice de lembretes diários,
//   mantido pelo PUT /api/data (extraído do estado sincronizado do app).
function effectiveRoutineId(S, iso) {
  const ov = S.dayPlan?.[iso];
  if (ov === 'rest') return null;
  if (ov && S.routines?.some(r => r.id === ov)) return ov;
  const wd = new Date(iso + 'T12:00:00').getDay();
  return S.week?.[wd] || null;
}
function userNow(tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    }).formatToParts(new Date());
    const g = t => parts.find(p => p.type === t)?.value;
    const date = `${g('year')}-${g('month')}-${g('day')}`;
    return { date, hhmm: `${g('hour')}:${g('minute')}`, weekday: new Date(date + 'T12:00:00Z').getUTCDay() };
  } catch { return null; }
}
// mantém o índice de lembretes em sinc com o estado salvo pelo app
async function syncReminderIndex(uid, S) {
  const on = !!S?.reminder?.on;
  const rems = await store.readJson('reminders', {});
  const cur = rems[uid];
  if (!on) {
    if (cur) { delete rems[uid]; await store.writeJson('reminders', rems); }
    return;
  }
  const next = { on: true, time: String(S.reminder.time || ''), tz: String(S.reminder.tz || 'UTC'), lastDate: cur?.lastDate || null };
  if (!next.time) return;
  if (!cur || cur.time !== next.time || cur.tz !== next.tz || cur.on !== true) {
    rems[uid] = next;
    await store.writeJson('reminders', rems);
  }
}
let lastTick = 0;
async function tick() {
  await ensureDb();
  const now = Date.now();
  let timersFired = 0, remindersFired = 0;
  // 1) timers de descanso vencidos → push e remove (claim antes de enviar)
  const timers = await store.readJson('timers', {});
  const due = Object.entries(timers).filter(([, at]) => +at <= now);
  if (due.length) {
    for (const [uid] of due) delete timers[uid];
    await store.writeJson('timers', timers);
    timersFired = due.length;
    for (const [uid] of due) sendPush(uid, { title: 'Rest over 💪', body: 'Time for your next set.', tag: 'rest-timer' }).catch(() => {});
  }
  // 2) lembretes diários no minuto local de cada usuário
  const rems = await store.readJson('reminders', {});
  for (const [uid, r] of Object.entries(rems)) {
    if (!r?.on) continue;
    const nowLocal = userNow(r.tz || 'UTC');
    if (!nowLocal || r.time !== nowLocal.hhmm) continue;
    if (r.lastDate === nowLocal.date) continue;
    const S = await readState(uid);
    if (!S) continue;
    if ((S.workouts || []).some(w => w.d === nowLocal.date)) continue;
    const rid = effectiveRoutineId(S, nowLocal.date);
    if (!rid) continue;                                   // dia de descanso — nada planejado
    const routine = (S.routines || []).find(x => x.id === rid);
    r.lastDate = nowLocal.date;                           // claim antes de enviar (evita duplicar)
    await store.writeJson('reminders', rems);
    remindersFired++;
    sendPush(uid, {
      title: routine ? `${routine.emoji || '🏋️'} ${routine.name} today` : 'Workout planned today',
      body: "It's on your plan — let's go 💪",
      tag: 'day-reminder'
    }).catch(() => {});
  }
  return { timersFired, remindersFired };
}
async function maybeTick() {
  if (Date.now() - lastTick < 20000) return;
  lastTick = Date.now();
  try { await tick(); } catch (e) { console.error('tick', e.message); }
}

/* ---------- rotas ---------- */
const routes = {
  'GET /api/health': async (req, res) => json(res, 200, { ok: true, users: db.users.length, backend: store.BACKEND, rp: RP_ID }),

  'GET /api/config': async (req, res) => {
    // edição serverless não tem AI Coach — o frontend lida com a ausência da flag
    json(res, 200, { invite_only: INVITE_ONLY, brand: billing.BRAND, billing: billing.publicBilling() });
  },

  'GET /api/me': async (req, res) => {
    const user = await readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    json(res, 200, { user: { id: user.id, name: user.name, admin: isAdmin(user), billing: { ...billing.meBilling(user), pending: !!billing.pendingPayment(db, user.id) } } });
  },

  'POST /api/register/options': async (req, res) => {
    const body = await readBody(req);
    const name = String(body.name || '').trim().slice(0, 40);
    if (!name) return json(res, 400, { error: 'name required' });
    const code = String(body.code || '').trim().toUpperCase();
    if (INVITE_ONLY && !db.invites.some(i => i.code === code && !i.usedBy && !i.revoked))
      return json(res, 403, { error: 'a valid invite code is required' });
    const uid = crypto.randomBytes(12).toString('base64url');
    const options = await generateRegistrationOptions({
      rpName: RP_NAME, rpID: RP_ID,
      userID: Buffer.from(uid), userName: name, userDisplayName: name,
      attestationType: 'none',
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
      excludeCredentials: []
    });
    const cid = await putChallenge({ challenge: options.challenge, name, uid, code });
    json(res, 200, { cid, options });
  },

  'POST /api/register/verify': async (req, res) => {
    const body = await readBody(req);
    const c = await takeChallenge(body.cid);
    if (!c || !c.uid) return json(res, 400, { error: 'challenge expired — try again' });
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: body.credential,
        expectedChallenge: c.challenge,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
        requireUserVerification: false
      });
    } catch (e) { return json(res, 400, { error: 'verification failed: ' + e.message }); }
    if (!verification.verified) return json(res, 400, { error: 'not verified' });
    const { credential } = verification.registrationInfo;
    if (db.creds.find(x => x.id === credential.id)) return json(res, 409, { error: 'credential already registered' });
    let invite = null;
    if (INVITE_ONLY) {
      invite = db.invites.find(i => i.code === c.code && !i.usedBy && !i.revoked);
      if (!invite) return json(res, 403, { error: 'invite code is no longer valid — ask for a new one' });
    }
    const user = { id: c.uid, name: c.name, created: new Date().toISOString() };
    if (invite) { user.invitedBy = invite.code; invite.usedBy = user.id; invite.usedAt = user.created; }
    user.billing = billing.newUserBilling();
    db.users.push(user);
    db.creds.push({
      id: credential.id, userId: user.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter || 0,
      transports: body.credential?.response?.transports || []
    });
    await saveDb();
    json(res, 200, { user: { id: user.id, name: user.name, admin: isAdmin(user), billing: { ...billing.meBilling(user) } } }, { 'Set-Cookie': sessionCookie(user) });
  },

  'POST /api/login/options': async (req, res) => {
    const options = await generateAuthenticationOptions({
      rpID: RP_ID, userVerification: 'preferred', allowCredentials: []
    });
    const cid = await putChallenge({ challenge: options.challenge });
    json(res, 200, { cid, options });
  },

  'POST /api/login/verify': async (req, res) => {
    const body = await readBody(req);
    const c = await takeChallenge(body.cid);
    if (!c) return json(res, 400, { error: 'challenge expired — try again' });
    const cred = db.creds.find(x => x.id === body.credential?.id);
    if (!cred) return json(res, 404, { error: 'unknown passkey — create a profile first' });
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: body.credential,
        expectedChallenge: c.challenge,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
        requireUserVerification: false,
        credential: {
          id: cred.id,
          publicKey: b64uToBuf(cred.publicKey),
          counter: cred.counter,
          transports: cred.transports
        }
      });
    } catch (e) { return json(res, 400, { error: 'verification failed: ' + e.message }); }
    if (!verification.verified) return json(res, 400, { error: 'not verified' });
    cred.counter = verification.authenticationInfo.newCounter;
    await saveDb();
    const user = db.users.find(u => u.id === cred.userId);
    if (!user) return json(res, 500, { error: 'user missing' });
    if (user.disabled) return json(res, 403, { error: 'this account has been disabled' });
    json(res, 200, { user: { id: user.id, name: user.name, admin: isAdmin(user), billing: { ...billing.meBilling(user) } } }, { 'Set-Cookie': sessionCookie(user) });
  },

  'POST /api/logout': async (req, res) => json(res, 200, { ok: true }, { 'Set-Cookie': clearCookie }),

  'POST /api/logout/all': async (req, res) => {
    const user = await readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    user.sv = sessionVersion(user) + 1;
    await saveDb();
    json(res, 200, { ok: true }, { 'Set-Cookie': clearCookie });
  },

  'GET /api/data': async (req, res) => {
    const user = await requireAccess(req, res); if (!user) return;
    const state = await readState(user.id);
    json(res, 200, { state: state ?? null });
  },

  'PUT /api/data': async (req, res) => {
    const user = await requireAccess(req, res); if (!user) return;
    const body = await readBody(req);
    if (!body.state || typeof body.state !== 'object') return json(res, 400, { error: 'state required' });
    delete body.state.active;              // treinos em progresso ficam locais no aparelho
    await writeState(user.id, body.state);
    syncReminderIndex(user.id, body.state).catch(e => console.error('reminder index', e.message));
    json(res, 200, { ok: true, ts: body.state._ts || null });
  },

  'GET /api/push/public-key': async (req, res) => json(res, 200, { key: vapid.publicKey }),

  'POST /api/push/subscribe': async (req, res) => {
    const user = await requireAccess(req, res); if (!user) return;
    const body = await readBody(req);
    const sub = body.subscription;
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) return json(res, 400, { error: 'invalid subscription' });
    db.subs = db.subs.filter(s => s.endpoint !== sub.endpoint);
    db.subs.push({ userId: user.id, endpoint: sub.endpoint, keys: sub.keys, created: new Date().toISOString() });
    await saveDb();
    json(res, 200, { ok: true });
  },

  'POST /api/push/unsubscribe': async (req, res) => {
    const user = await readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    db.subs = db.subs.filter(s => !(s.userId === user.id && s.endpoint === body.endpoint));
    await saveDb();
    json(res, 200, { ok: true });
  },

  'POST /api/push/test': async (req, res) => {
    const user = await requireAccess(req, res); if (!user) return;
    await sendPush(user.id, { title: 'openGym', body: 'Test notification ✅ — this is what alerts look like.', tag: 'test' });
    json(res, 200, { ok: true });
  },

  'POST /api/push/rest-timer': async (req, res) => {
    const user = await requireAccess(req, res); if (!user) return;
    const body = await readBody(req);
    const sec = Math.max(1, Math.min(3600, Math.round(+body.seconds || 0)));
    if (!sec) return json(res, 400, { error: 'seconds required' });
    // sem setTimeout de processo: o timer vira registro e o tick cooperativo dispara
    const timers = await store.readJson('timers', {});
    timers[user.id] = Date.now() + sec * 1000;
    await store.writeJson('timers', timers);
    json(res, 200, { ok: true });
  },

  'POST /api/push/rest-timer/cancel': async (req, res) => {
    const user = await readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const timers = await store.readJson('timers', {});
    if (user.id in timers) { delete timers[user.id]; await store.writeJson('timers', timers); }
    json(res, 200, { ok: true });
  },

  'POST /api/activity': async (req, res) => {
    const user = await readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    if (body.active) {
      presence.set(user.id, {
        name: String(body.name || '').slice(0, 60),
        exIdx: +body.exIdx || 0, exTotal: +body.exTotal || 0,
        setsDone: +body.setsDone || 0, setsTotal: +body.setsTotal || 0,
        startedAt: +body.startedAt || Date.now(),
        updatedAt: Date.now()
      });
    } else presence.delete(user.id);
    json(res, 200, { ok: true });
  },

  /* ---------- tick (cron diário da Vercel + Actions do GitHub + requisições) ---------- */
  'GET /api/cron/tick': async (req, res) => {
    const auth = req.headers.authorization || '';
    if (!CRON_SECRET || auth !== 'Bearer ' + CRON_SECRET) return json(res, 403, { error: 'forbidden' });
    const out = await tick();
    json(res, 200, { ok: true, ...out });
  },

  /* ---------- admin dashboard (dentro do app) ---------- */
  'GET /api/admin/users': async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    const users = await Promise.all(db.users.map(async u => {
      const S = (await readState(u.id)) || {};
      const workouts = S.workouts || [];
      const last = workouts[workouts.length - 1];
      return {
        id: u.id, name: u.name, created: u.created || null,
        disabled: !!u.disabled, admin: isAdmin(u), invitedBy: u.invitedBy || null,
        workouts: workouts.length,
        lastWorkout: last ? last.d : null,
        lastSync: S._ts || null,
        hasPush: db.subs.some(s => s.userId === u.id),
        live: livePresence(u.id)
      };
    }));
    json(res, 200, { users, invite_only: INVITE_ONLY, now: Date.now() });
  },

  'GET /api/admin/user': async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    const id = new URL(req.url, 'http://x').searchParams.get('id');
    const u = db.users.find(x => x.id === id);
    if (!u) return json(res, 404, { error: 'no such user' });
    const S = (await readState(u.id)) || {};
    json(res, 200, {
      user: { id: u.id, name: u.name, created: u.created || null, disabled: !!u.disabled, admin: isAdmin(u), invitedBy: u.invitedBy || null },
      unit: S.unit || 'kg',
      lastSync: S._ts || null,
      routines: (S.routines || []).map(r => ({ id: r.id, name: r.name, emoji: r.emoji, count: (r.ex || []).length })),
      bodyweight: S.bodyweight || [],
      workouts: (S.workouts || []).slice().reverse()
    });
  },

  'POST /api/admin/user/disable': async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    const body = await readBody(req);
    const u = db.users.find(x => x.id === body.id);
    if (!u) return json(res, 404, { error: 'no such user' });
    if (isAdmin(u)) return json(res, 400, { error: 'cannot disable an admin' });
    u.disabled = !!body.disabled;
    if (u.disabled) presence.delete(u.id);
    await saveDb();
    json(res, 200, { ok: true, id: u.id, disabled: u.disabled });
  },

  'GET /api/admin/invites': async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    const invites = db.invites.map(i => ({
      ...i, usedByName: i.usedBy ? (db.users.find(u => u.id === i.usedBy) || {}).name || null : null
    }));
    json(res, 200, { invites, invite_only: INVITE_ONLY });
  },

  'POST /api/admin/invites/new': async (req, res) => {
    const admin = await requireAdmin(req, res); if (!admin) return;
    const body = await readBody(req);
    let code;
    do { code = crypto.randomBytes(8).toString('hex').toUpperCase(); } while (db.invites.some(i => i.code === code));
    const invite = { code, note: String(body.note || '').slice(0, 60), createdBy: admin.id, created: new Date().toISOString() };
    db.invites.push(invite);
    await saveDb();
    json(res, 200, { invite });
  },

  'POST /api/admin/invites/revoke': async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    const body = await readBody(req);
    const inv = db.invites.find(i => i.code === String(body.code || '').toUpperCase());
    if (!inv) return json(res, 404, { error: 'no such code' });
    if (inv.usedBy) return json(res, 400, { error: 'already used — cannot revoke' });
    db.invites = db.invites.filter(i => i.code !== inv.code);
    await saveDb();
    json(res, 200, { ok: true });
  },

  /* ---------- faturamento (usuário) ---------- */
  'GET /api/billing/status': async (req, res) => {
    const user = await readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    json(res, 200, {
      billing: { ...billing.meBilling(user), pending: !!billing.pendingPayment(db, user.id) },
      config: billing.publicBilling()
    });
  },

  'POST /api/billing/checkout': async (req, res) => {
    const user = await readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    if (user.disabled) return json(res, 403, { error: 'this account has been disabled' });
    if (billing.CHECKOUT_METHOD === 'none') return json(res, 503, { error: 'nenhum método de pagamento configurado no servidor' });
    const existing = billing.pendingPayment(db, user.id);
    if (existing) return json(res, 200, { payment: existing, ...(existing.initPoint ? { initPoint: existing.initPoint } : {}) });
    let payment;
    if (billing.CHECKOUT_METHOD === 'mp') {
      payment = billing.createPayment(db, user.id, billing.PRICE, 'mp');
      try {
        const pref = await billing.mpCreatePreference(billing.MP_TOKEN, {
          title: `${billing.BRAND} — assinatura mensal`,
          price: billing.PRICE, currency: billing.CURRENCY,
          externalReference: payment.id,
          backUrl: ORIGIN + '/#/billing',
          notificationUrl: process.env.MP_WEBHOOK_URL || ORIGIN + '/api/billing/webhook'
        });
        payment.prefId = pref.id; payment.initPoint = pref.initPoint;
      } catch (e) {
        payment.status = 'failed'; payment.error = String(e.message || e).slice(0, 200);
        await saveDb();
        return json(res, 502, { error: 'falha ao criar cobrança no Mercado Pago' });
      }
    } else {
      payment = billing.createPayment(db, user.id, billing.PRICE, 'pix');
    }
    await saveDb();
    json(res, 200, { payment, ...(payment.initPoint ? { initPoint: payment.initPoint } : {}), ...(billing.CHECKOUT_METHOD === 'pix' ? { pix: { key: billing.PIX_KEY, holder: billing.PIX_HOLDER, amount: billing.PRICE, currency: billing.CURRENCY } } : {}) });
  },

  'POST /api/billing/webhook': async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const body = await readBody(req).catch(() => ({}));
    const mpPaymentId = body?.data?.id || url.searchParams.get('data.id') || url.searchParams.get('id');
    if (!billing.MP_TOKEN || !mpPaymentId) return json(res, 200, { ok: true });
    try {
      const mp = await billing.mpFetchPayment(billing.MP_TOKEN, mpPaymentId);
      if (mp.status !== 'approved' || !mp.external_reference) return json(res, 200, { ok: true, ignored: mp.status });
      const local = (db.payments || []).find(p => p.id === mp.external_reference);
      if (!local || local.status !== 'pending') return json(res, 200, { ok: true, ignored: 'no pending payment' });
      local.mpPaymentId = String(mp.id);
      local.paidAmount = mp.transaction_amount;
      const u = billing.approvePayment(db, local.id, { by: 'mercadopago' });
      await saveDb();
      if (u) sendPush(u.id, { title: `${billing.BRAND}`, body: 'Pagamento aprovado — bom treino! 💪', tag: 'billing' }).catch(() => {});
      json(res, 200, { ok: true });
    } catch (e) {
      console.error('billing webhook', e);
      json(res, 500, { error: 'webhook error' });
    }
  },

  /* ---------- painel admin (autenticação dedicada, separada do app) ---------- */
  'POST /api/panel/login': async (req, res) => {
    const body = await readBody(req);
    const username = String(body.username || '').trim();
    const key = billing.attemptsKey(clientIp(req), username);
    if (panelRateLimited(key)) return json(res, 429, { error: 'muitas tentativas — aguarde alguns minutos' });
    if (!db.admins.length) return json(res, 403, { error: 'painel não configurado — defina ADMIN_USERNAME e ADMIN_PASSWORD no ambiente' });
    const admin = db.admins.find(a => a.username === username);
    if (!admin || !billing.verifyPassword(String(body.password || ''), admin.salt, admin.hash))
      return json(res, 401, { error: 'usuário ou senha incorretos' });
    panelAttempts.delete(key);
    json(res, 200, { ok: true, username: admin.username }, { 'Set-Cookie': panelCookie(billing.makePanelToken(admin.id, SECRET, undefined, Date.now(), admin.pnlSv || 0)) });
  },

  'POST /api/panel/logout': async (req, res) => {
    const admin = await readPanelSession(req);
    if (admin) { admin.pnlSv = (admin.pnlSv || 0) + 1; await saveDb(); }
    json(res, 200, { ok: true }, { 'Set-Cookie': panelClearCookie });
  },

  'GET /api/panel/me': async (req, res) => {
    const admin = await requirePanel(req, res); if (!admin) return;
    json(res, 200, { username: admin.username });
  },

  'GET /api/panel/overview': async (req, res) => {
    const admin = await requirePanel(req, res); if (!admin) return;
    const now = Date.now();
    const by = { free: 0, active: 0, trial: 0, overdue: 0 };
    let disabled = 0;
    for (const u of db.users) {
      if (u.disabled) disabled++;
      by[billing.billingStatus(u, now).code]++;
    }
    const since = now - 30 * 86400000;
    const rev30 = (db.payments || [])
      .filter(p => p.status === 'approved' && p.approvedAt && +new Date(p.approvedAt) >= since)
      .reduce((s, p) => s + (+p.amount || 0), 0);
    json(res, 200, {
      users: db.users.length, disabled, by,
      mrr: by.active * billing.PRICE,
      revenue30: Math.round(rev30 * 100) / 100,
      pendingPayments: (db.payments || []).filter(p => p.status === 'pending').length,
      price: billing.PRICE, currency: billing.CURRENCY, brand: billing.BRAND, trialDays: billing.TRIAL_DAYS,
      now
    });
  },

  'GET /api/panel/users': async (req, res) => {
    const admin = await requirePanel(req, res); if (!admin) return;
    const now = Date.now();
    const users = await Promise.all(db.users.map(async u => {
      const S = (await readState(u.id)) || {};
      const workouts = S.workouts || [];
      const pend = billing.pendingPayment(db, u.id);
      return {
        id: u.id, name: u.name, created: u.created || null, disabled: !!u.disabled,
        billing: { ...billing.billingStatus(u, now), status2: u.billing?.status || null, note: u.billing?.note || null, pendingId: pend ? pend.id : null, pendingMethod: pend ? pend.method : null },
        workouts: workouts.length,
        lastWorkout: workouts.length ? workouts[workouts.length - 1].d : null,
        lastSync: S._ts || null
      };
    }));
    json(res, 200, { users, now });
  },

  'GET /api/panel/payments': async (req, res) => {
    const admin = await requirePanel(req, res); if (!admin) return;
    const payments = (db.payments || []).slice().reverse().map(p => ({
      ...p, userName: (db.users.find(u => u.id === p.userId) || {}).name || '(perfil removido)'
    }));
    json(res, 200, { payments });
  },

  'POST /api/panel/user/free': async (req, res) => {
    const admin = await requirePanel(req, res); if (!admin) return;
    const body = await readBody(req);
    const u = db.users.find(x => x.id === body.id);
    if (!u) return json(res, 404, { error: 'no such user' });
    billing.grantFree(u, !!body.free, body.free ? 'isento pelo painel' : null);
    await saveDb();
    json(res, 200, { ok: true, id: u.id, free: !!body.free, billing: billing.billingStatus(u) });
  },

  'POST /api/panel/user/disable': async (req, res) => {
    const admin = await requirePanel(req, res); if (!admin) return;
    const body = await readBody(req);
    const u = db.users.find(x => x.id === body.id);
    if (!u) return json(res, 404, { error: 'no such user' });
    u.disabled = !!body.disabled;
    if (u.disabled) presence.delete(u.id);
    await saveDb();
    json(res, 200, { ok: true, id: u.id, disabled: u.disabled });
  },

  'POST /api/panel/user/extend': async (req, res) => {
    const admin = await requirePanel(req, res); if (!admin) return;
    const body = await readBody(req);
    const u = db.users.find(x => x.id === body.id);
    if (!u) return json(res, 404, { error: 'no such user' });
    const days = Math.max(1, Math.min(365, Math.round(+body.days || 0)));
    if (!days) return json(res, 400, { error: 'days required' });
    const b = u.billing = u.billing || billing.newUserBilling(0);
    if (b.free) return json(res, 400, { error: 'perfil isento — remova a isenção antes de estender' });
    const now = Date.now();
    const base = b.periodEnd && +new Date(b.periodEnd) > now ? +new Date(b.periodEnd) : now;
    b.status = 'active';
    b.periodEnd = new Date(base + days * 86400000).toISOString();
    await saveDb();
    json(res, 200, { ok: true, billing: billing.billingStatus(u) });
  },

  'POST /api/panel/payment/approve': async (req, res) => {
    const admin = await requirePanel(req, res); if (!admin) return;
    const body = await readBody(req);
    const u = billing.approvePayment(db, String(body.id || ''), { by: admin.username });
    if (!u) return json(res, 404, { error: 'cobrança pendente não encontrada' });
    await saveDb();
    sendPush(u.id, { title: `${billing.BRAND}`, body: 'Pagamento aprovado — bom treino! 💪', tag: 'billing' }).catch(() => {});
    json(res, 200, { ok: true, billing: billing.billingStatus(u) });
  },

  'POST /api/panel/payment/reject': async (req, res) => {
    const admin = await requirePanel(req, res); if (!admin) return;
    const body = await readBody(req);
    const p = billing.rejectPayment(db, String(body.id || ''), { by: admin.username });
    if (!p) return json(res, 404, { error: 'cobrança pendente não encontrada' });
    await saveDb();
    json(res, 200, { ok: true });
  }
};

/* handler principal: rotas exatas + prefixos (coach → 503) + 404 */
export default async function handler(req, res) {
  try {
    await init();
    const url = new URL(req.url, 'http://x');
    const pathname = url.pathname.replace(/\/+$/, '') || url.pathname;
    const key = req.method + ' ' + pathname;
    const handler = routes[key];
    if (handler) {
      await maybeTick();               // aguardado: trabalho pós-resposta pode ser cortado no serverless
      await handler(req, res);
      return;
    }
    if (pathname.startsWith('/api/coach/') || pathname.startsWith('/api/admin/coach')) {
      return json(res, 503, { error: 'AI Coach indisponível nesta hospedagem gratuita — feature exclusiva da versão self-hosted (Docker).' });
    }
    if (!pathname.startsWith('/api/')) return json(res, 404, { error: 'not found' });
    json(res, 404, { error: 'not found' });
  } catch (e) {
    console.error('api error', req.url, e);
    if (!res.headersSent) json(res, 500, { error: 'server error' });
    else try { res.end(); } catch { /* */ }
  }
}
