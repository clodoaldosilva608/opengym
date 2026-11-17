/* opengym-api — passkey (WebAuthn) auth + per-user state storage for openGym
   No framework, JSON-file storage, signed session cookies.               */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse
} from '@simplewebauthn/server';
import webpush from 'web-push';
import * as coachConfig from './coach/config.js';
import * as coachJobs from './coach/jobs.js';
import { coachRoutes } from './coach/routes.js';
import { startCadence } from './coach/cadence.js';
import * as billing from './billing.js';

const PORT = +(process.env.PORT || 3000);
const DATA = process.env.DATA_DIR || '/data';
const RP_ID = process.env.RP_ID || 'localhost';
const ORIGIN = process.env.ORIGIN || 'http://localhost:8080';
const RP_NAME = process.env.RP_NAME || 'openGym';
// Admin dashboard (issue): admins are matched by uid; INVITE_ONLY gates new signups behind a
// code the admin generates. Both default off so a fresh self-hosted instance stays open.
const ADMIN_UIDS = (process.env.ADMIN_UIDS || '').split(',').map(s => s.trim()).filter(Boolean);
const INVITE_ONLY = /^(1|true|yes|on)$/i.test(process.env.INVITE_ONLY || '');
// 90 days keeps someone who trains a few times a week permanently signed in without a stolen
// cookie staying good for a year. Overridable because a family instance and one on the open
// internet don't want the same number. Only affects cookies minted from now on — the expiry is
// baked into each cookie when it's issued, so lowering this never cuts an existing session short.
const SESSION_DAYS = Math.max(1, +(process.env.SESSION_DAYS || 90) || 90);
const MAX_BODY = 5 * 1024 * 1024;
// Secure cookies require HTTPS; over plain http://localhost the flag would drop the cookie
const SECURE = /^https:/i.test(ORIGIN) ? ' Secure;' : '';

fs.mkdirSync(DATA, { recursive: true });
// 0700 is what stops the unprivileged user that Coach jobs run as from reading any of this —
// state files, db.json, the session secret, the provider credential. The Agent SDK process gets
// its job payload in a temp directory and nothing else. Best-effort: a bind-mounted host directory
// may refuse the chmod, and that is not a reason to refuse to boot.
try { fs.chmodSync(DATA, 0o700); } catch { /* host filesystem says no — carry on */ }

/* ---------- secret + db ---------- */
const secretFile = path.join(DATA, 'secret');
if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
const SECRET = fs.readFileSync(secretFile, 'utf8').trim();

const dbFile = path.join(DATA, 'db.json');
let db = { users: [], creds: [], subs: [], invites: [], payments: [], admins: [] };
try { db = JSON.parse(fs.readFileSync(dbFile, 'utf8')); } catch {}
db.subs = db.subs || [];
db.invites = db.invites || [];
db.payments = db.payments || [];
db.admins = db.admins || [];
// Faturamento: perfis pré-existentes viram isentos (é o dono da instância); novos cadastros
// começam em trial. Roda no boot a cada start — é idempotente.
billing.migrateBilling(db);
saveDb();   // persiste a migração de billing na hora do boot (idempotente, escreve 1× por start)

// Bootstrap do painel admin separado (usuário+senha, cookie próprio). Só cria/atualiza se as
// duas variáveis vierem no ambiente — o painel pode também ser usado sem credenciais de env
// criando um admin manualmente no db.json (campo admins).
if (billing.ADMIN_USERNAME && billing.ADMIN_PASSWORD) {
  const existing = db.admins.find(a => a.username === billing.ADMIN_USERNAME);
  if (!existing) {
    const { salt, hash } = billing.hashPassword(billing.ADMIN_PASSWORD);
    db.admins.push({ id: crypto.randomBytes(8).toString('base64url'), username: billing.ADMIN_USERNAME, salt, hash, created: new Date().toISOString() });
    console.log('painel admin: credencial criada para', billing.ADMIN_USERNAME);
  } else if (!billing.verifyPassword(billing.ADMIN_PASSWORD, existing.salt, existing.hash)) {
    Object.assign(existing, billing.hashPassword(billing.ADMIN_PASSWORD));
    console.log('painel admin: senha atualizada para', billing.ADMIN_USERNAME);
  }
  saveDb();
}
const isAdmin = user => !!user && (user.admin === true || ADMIN_UIDS.includes(user.id));
function saveDb() { atomicWrite(dbFile, JSON.stringify(db, null, 2)); }
function atomicWrite(file, content) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}
const stateFile = uid => path.join(DATA, 'state-' + uid.replace(/[^a-zA-Z0-9_-]/g, '') + '.json');
function readState(uid) {
  try { return JSON.parse(fs.readFileSync(stateFile(uid), 'utf8')); } catch { return null; }
}

/* ---------- push notifications (Web Push / VAPID) ---------- */
const vapidFile = path.join(DATA, 'vapid.json');
let vapid;
try { vapid = JSON.parse(fs.readFileSync(vapidFile, 'utf8')); }
catch { vapid = webpush.generateVAPIDKeys(); fs.writeFileSync(vapidFile, JSON.stringify(vapid), { mode: 0o600 }); }
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || (SECURE ? ORIGIN : 'mailto:admin@localhost');
webpush.setVapidDetails(VAPID_SUBJECT, vapid.publicKey, vapid.privateKey);

async function sendPush(userId, payload) {
  const subs = db.subs.filter(s => s.userId === userId);
  if (!subs.length) return;
  const body = JSON.stringify(payload);
  let dirty = false;
  await Promise.all(subs.map(async sub => {
    // urgency 'high' is the one lever we have over delivery speed — iOS/Android throttle
    // low-urgency background push more aggressively under battery-saving modes. TTL is left
    // at the library default (long) so a briefly-offline device still gets it once reconnected,
    // rather than risking it being dropped for the sake of shaving off latency that TTL doesn't
    // actually control anyway.
    try { await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, body, { urgency: 'high' }); }
    catch (e) {
      console.error('push send failed', userId, e.statusCode, e.body || e.message);
      if (e.statusCode === 404 || e.statusCode === 410) {
        db.subs = db.subs.filter(s => s.endpoint !== sub.endpoint); dirty = true;
      }
    }
  }));
  if (dirty) saveDb();
}

// Rest-timer alerts: client schedules on start/extend, cancels on skip or on-screen completion —
// this only fires when the tab was backgrounded/suspended and never got to cancel it itself.
const restTimers = new Map(); // userId -> Timeout
function scheduleRestTimer(userId, sec) {
  const t = restTimers.get(userId);
  if (t) clearTimeout(t);
  restTimers.set(userId, setTimeout(() => {
    restTimers.delete(userId);
    sendPush(userId, { title: 'Rest over 💪', body: 'Time for your next set.', tag: 'rest-timer' });
  }, sec * 1000));
}
function cancelRestTimer(userId) {
  const t = restTimers.get(userId);
  if (t) { clearTimeout(t); restTimers.delete(userId); }
}

// "Workout planned today" reminder — one per user per day, at their chosen time.
// Duplicated (not imported) from frontend/src/lib/history.js effectiveRoutineId — tiny pure helper, not worth sharing across the two runtimes.
function effectiveRoutineId(S, iso) {
  const ov = S.dayPlan?.[iso];
  if (ov === 'rest') return null;
  if (ov && S.routines?.some(r => r.id === ov)) return ov;
  const wd = new Date(iso + 'T12:00:00').getDay();
  return S.week?.[wd] || null;
}
// Computes "now" in an arbitrary IANA zone (e.g. "Europe/Lisbon") instead of the server's own —
// each user's reminder fires by their own clock, wherever they and their phone actually are.
function userNow(tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    }).formatToParts(new Date());
    const g = t => parts.find(p => p.type === t)?.value;
    const date = `${g('year')}-${g('month')}-${g('day')}`;
    // Weekday is derived from the zone's own date, not the server's — a Sunday-evening review
    // has to be Sunday where the user is, which is what the reminder already assumes for time.
    return { date, hhmm: `${g('hour')}:${g('minute')}`, weekday: new Date(date + 'T12:00:00Z').getUTCDay() };
  } catch { return null; } // unknown/invalid tz string — skip this user rather than guess
}
setInterval(() => {
  for (const user of db.users) {
    if (!db.subs.some(s => s.userId === user.id)) continue;
    const S = readState(user.id);
    if (!S?.reminder?.on) continue;
    const now = userNow(S.reminder.tz || 'UTC');
    if (!now || S.reminder.time !== now.hhmm) continue;
    if (user.lastReminder === now.date) continue;
    if ((S.workouts || []).some(w => w.d === now.date)) continue;
    const rid = effectiveRoutineId(S, now.date);
    if (!rid) continue; // rest day — nothing planned
    const routine = (S.routines || []).find(r => r.id === rid);
    console.log('reminder firing', user.id, rid);
    user.lastReminder = now.date;
    saveDb();
    sendPush(user.id, {
      title: routine ? `${routine.emoji || '🏋️'} ${routine.name} today` : 'Workout planned today',
      body: "It's on your plan — let's go 💪",
      tag: 'day-reminder'
    });
  }
// Checked every 10s (not 60s) — ticks aren't aligned to the top of the minute, so a 60s
// interval could sit on your target minute for up to 59s before noticing. 10s caps that at ~9s.
}, 10000).unref();

/* ---------- sessions (signed cookie) ---------- */
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
// Session payload is `<uid>:<expiry>:<version>`, where the version is the user's `sv` counter.
// Bumping `sv` (POST /api/logout/all) makes every cookie ever handed out for that account stop
// verifying, which is the only revocation there was before short of deleting ./data/secret and
// signing out the whole instance. Cookies minted before `sv` existed have no third field and are
// read as version 0, matching a user who has never bumped — they stay valid until they expire.
const sessionVersion = user => user.sv || 0;
function makeSession(user) {
  const exp = Date.now() + SESSION_DAYS * 86400000;
  return sign(user.id + ':' + exp + ':' + sessionVersion(user));
}
function readSession(req) {
  const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(c => {
    const i = c.indexOf('='); return i < 0 ? ['', ''] : [c.slice(0, i).trim(), c.slice(i + 1).trim()];
  }));
  const tok = cookies.gymsid;
  if (!tok) return null;
  const payload = verifySig(tok);
  if (!payload) return null;
  const [uid, exp, ver] = payload.split(':');
  if (!uid || +exp < Date.now()) return null;
  const user = db.users.find(u => u.id === uid) || null;
  if (!user) return null;
  if (user.disabled) return null;           // disabled accounts are locked out everywhere
  // Missing third field = pre-versioning cookie = version 0. Anything non-numeric is a malformed
  // payload (it still had to pass the HMAC, so this is belt-and-braces) and is refused outright.
  const claimed = ver === undefined ? 0 : Number(ver);
  if (!Number.isInteger(claimed) || claimed !== sessionVersion(user)) return null;
  return user;
}
// Guard for /api/admin/* — resolves the caller and 401/403s if they aren't an admin.
function requireAdmin(req, res) {
  const user = readSession(req);
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
function readPanelSession(req) {
  const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(c => {
    const i = c.indexOf('='); return i < 0 ? ['', ''] : [c.slice(0, i).trim(), c.slice(i + 1).trim()];
  }));
  const t = billing.readPanelToken(cookies[PANEL_COOKIE], SECRET);
  if (!t) return null;
  const admin = db.admins.find(a => a.id === t.adminId);
  if (!admin) return null;
  if ((admin.pnlSv || 0) !== t.ver) return null;   // logout bumpa a versão — tokens antigos morrem
  return admin;
}
function requirePanel(req, res) {
  const admin = readPanelSession(req);
  if (!admin) { json(res, 401, { error: 'sessão do painel expirada' }); return null; }
  return admin;
}

/* ---------- gate de assinatura ---------- */
// Perfis isentos/ativos/em trial passam; vencidos recebem 402 com o resumo do billing.
function requireAccess(req, res) {
  const user = readSession(req);
  if (!user) { json(res, 401, { error: 'not signed in' }); return null; }
  if (!billing.hasAccess(user)) {
    json(res, 402, { error: 'subscription required', billing: { ...billing.meBilling(user), pending: !!billing.pendingPayment(db, user.id) } });
    return null;
  }
  return user;
}

// Rate-limit do login do painel: 10 tentativas por janela de 10 min por chave username+IP.
const panelAttempts = new Map();
function panelRateLimited(key) {
  const now = Date.now();
  let rec = panelAttempts.get(key);
  if (!rec || now > rec.reset) { rec = { n: 0, reset: now + 600000 }; panelAttempts.set(key, rec); }
  rec.n++;
  return rec.n > 10;
}

/* ---------- challenge store (in-memory, 5 min TTL) ---------- */
const challenges = new Map(); // cid -> {challenge, name?, uid?, exp}
function putChallenge(data) {
  const cid = crypto.randomBytes(16).toString('base64url');
  challenges.set(cid, { ...data, exp: Date.now() + 5 * 60000 });
  return cid;
}
function takeChallenge(cid) {
  const c = challenges.get(cid);
  challenges.delete(cid);
  if (!c || c.exp < Date.now()) return null;
  return c;
}
setInterval(() => { for (const [k, v] of challenges) if (v.exp < Date.now()) challenges.delete(k); }, 60000).unref();

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

/* ---------- live presence (in-memory) ---------- */
// Clients heartbeat /api/activity while a workout is on screen; the admin dashboard reads who's
// live. Purely ephemeral — never persisted. Expires shortly after the last ping.
const presence = new Map();               // uid -> { name, exIdx, exTotal, setsDone, setsTotal, startedAt, updatedAt }
const PRESENCE_TTL = 70000;               // ~3.5× the 20s client heartbeat
function livePresence(uid) {
  const p = presence.get(uid);
  if (!p) return null;
  if (Date.now() - p.updatedAt > PRESENCE_TTL) { presence.delete(uid); return null; }
  return p;
}
setInterval(() => { for (const [k, v] of presence) if (Date.now() - v.updatedAt > PRESENCE_TTL) presence.delete(k); }, 30000).unref();

/* ---------- routes ---------- */
const routes = {
  'GET /api/health': async (req, res) => json(res, 200, { ok: true, users: db.users.length }),

  // Public config the login screen needs before anyone is signed in. `coach` is absent unless
  // the instance has both switched the Coach on and successfully connected a provider — the
  // single flag every piece of Coach UI hangs off, so an unconfigured instance is byte-for-byte
  // the app it was before the feature existed.
  'GET /api/config': async (req, res) => {
    const coach = coachConfig.publicConfig();
    json(res, 200, { invite_only: INVITE_ONLY, brand: billing.BRAND, billing: billing.publicBilling(), ...(coach ? { coach } : {}) });
  },

  'GET /api/me': async (req, res) => {
    const user = readSession(req);
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
    const cid = putChallenge({ challenge: options.challenge, name, uid, code });
    json(res, 200, { cid, options });
  },

  'POST /api/register/verify': async (req, res) => {
    const body = await readBody(req);
    const c = takeChallenge(body.cid);
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
    // Re-check the invite at the last moment (it may have been used/revoked since options), then burn it.
    let invite = null;
    if (INVITE_ONLY) {
      invite = db.invites.find(i => i.code === c.code && !i.usedBy && !i.revoked);
      if (!invite) return json(res, 403, { error: 'invite code is no longer valid — ask for a new one' });
    }
    const user = { id: c.uid, name: c.name, created: new Date().toISOString() };
    if (invite) { user.invitedBy = invite.code; invite.usedBy = user.id; invite.usedAt = user.created; }
    // Todo perfil novo entra em trial — o dono da instância já veio isento pela migração.
    user.billing = billing.newUserBilling();
    db.users.push(user);
    db.creds.push({
      id: credential.id, userId: user.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter || 0,
      transports: body.credential?.response?.transports || []
    });
    saveDb();
    json(res, 200, { user: { id: user.id, name: user.name, admin: isAdmin(user), billing: { ...billing.meBilling(user) } } }, { 'Set-Cookie': sessionCookie(user) });
  },

  'POST /api/login/options': async (req, res) => {
    const options = await generateAuthenticationOptions({
      rpID: RP_ID, userVerification: 'preferred', allowCredentials: []
    });
    const cid = putChallenge({ challenge: options.challenge });
    json(res, 200, { cid, options });
  },

  'POST /api/login/verify': async (req, res) => {
    const body = await readBody(req);
    const c = takeChallenge(body.cid);
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
    saveDb();
    const user = db.users.find(u => u.id === cred.userId);
    if (!user) return json(res, 500, { error: 'user missing' });
    if (user.disabled) return json(res, 403, { error: 'this account has been disabled' });
    json(res, 200, { user: { id: user.id, name: user.name, admin: isAdmin(user), billing: { ...billing.meBilling(user) } } }, { 'Set-Cookie': sessionCookie(user) });
  },

  'POST /api/logout': async (req, res) => json(res, 200, { ok: true }, { 'Set-Cookie': clearCookie }),

  // "Sign out everywhere" — bumps this user's session version, which invalidates every cookie
  // ever issued for the account, on every device, including a copy someone else walked off with.
  // The caller's own cookie is cleared here too, so the browser doing it doesn't sit on a token
  // it no longer accepts. Passkeys are untouched: signing back in works immediately.
  'POST /api/logout/all': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    user.sv = sessionVersion(user) + 1;
    saveDb();
    json(res, 200, { ok: true }, { 'Set-Cookie': clearCookie });
  },

  'GET /api/data': async (req, res) => {
    const user = requireAccess(req, res); if (!user) return;
    try {
      const state = JSON.parse(fs.readFileSync(stateFile(user.id), 'utf8'));
      json(res, 200, { state });
    } catch { json(res, 200, { state: null }); }
  },

  'PUT /api/data': async (req, res) => {
    const user = requireAccess(req, res); if (!user) return;
    const body = await readBody(req);
    if (!body.state || typeof body.state !== 'object') return json(res, 400, { error: 'state required' });
    delete body.state.active;              // in-progress workouts stay device-local
    atomicWrite(stateFile(user.id), JSON.stringify(body.state));
    json(res, 200, { ok: true, ts: body.state._ts || null });
  },

  'GET /api/push/public-key': async (req, res) => json(res, 200, { key: vapid.publicKey }),

  'POST /api/push/subscribe': async (req, res) => {
    const user = requireAccess(req, res); if (!user) return;
    const body = await readBody(req);
    const sub = body.subscription;
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) return json(res, 400, { error: 'invalid subscription' });
    db.subs = db.subs.filter(s => s.endpoint !== sub.endpoint);
    db.subs.push({ userId: user.id, endpoint: sub.endpoint, keys: sub.keys, created: new Date().toISOString() });
    saveDb();
    json(res, 200, { ok: true });
  },

  'POST /api/push/unsubscribe': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    db.subs = db.subs.filter(s => !(s.userId === user.id && s.endpoint === body.endpoint));
    saveDb();
    json(res, 200, { ok: true });
  },

  'POST /api/push/test': async (req, res) => {
    const user = requireAccess(req, res); if (!user) return;
    await sendPush(user.id, { title: 'openGym', body: 'Test notification ✅ — this is what alerts look like.', tag: 'test' });
    json(res, 200, { ok: true });
  },

  'POST /api/push/rest-timer': async (req, res) => {
    const user = requireAccess(req, res); if (!user) return;
    const body = await readBody(req);
    const sec = Math.max(1, Math.min(3600, Math.round(+body.seconds || 0)));
    if (!sec) return json(res, 400, { error: 'seconds required' });
    scheduleRestTimer(user.id, sec);
    json(res, 200, { ok: true });
  },

  'POST /api/push/rest-timer/cancel': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    cancelRestTimer(user.id);
    json(res, 200, { ok: true });
  },

  // Live-workout heartbeat: client pings while a workout is on screen; { active:false } drops it.
  'POST /api/activity': async (req, res) => {
    const user = readSession(req);
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

  /* ---------- admin dashboard ---------- */
  // One row per user, cheap enough for a personal instance (reads each state file once).
  'GET /api/admin/users': async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const users = db.users.map(u => {
      const S = readState(u.id) || {};
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
    });
    json(res, 200, { users, invite_only: INVITE_ONLY, now: Date.now() });
  },

  // Drill-down: full workout history + body-weight log for one user.
  'GET /api/admin/user': async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const id = new URL(req.url, 'http://x').searchParams.get('id');
    const u = db.users.find(x => x.id === id);
    if (!u) return json(res, 404, { error: 'no such user' });
    const S = readState(u.id) || {};
    json(res, 200, {
      user: { id: u.id, name: u.name, created: u.created || null, disabled: !!u.disabled, admin: isAdmin(u), invitedBy: u.invitedBy || null },
      unit: S.unit || 'kg',
      lastSync: S._ts || null,
      routines: (S.routines || []).map(r => ({ id: r.id, name: r.name, emoji: r.emoji, count: (r.ex || []).length })),
      bodyweight: S.bodyweight || [],
      workouts: (S.workouts || []).slice().reverse()   // newest first for display
    });
  },

  'POST /api/admin/user/disable': async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const body = await readBody(req);
    const u = db.users.find(x => x.id === body.id);
    if (!u) return json(res, 404, { error: 'no such user' });
    if (isAdmin(u)) return json(res, 400, { error: 'cannot disable an admin' });
    u.disabled = !!body.disabled;
    if (u.disabled) presence.delete(u.id);   // drop them off "training now" at once
    saveDb();
    json(res, 200, { ok: true, id: u.id, disabled: u.disabled });
  },

  'GET /api/admin/invites': async (req, res) => {
    if (!requireAdmin(req, res)) return;
    // resolve usedBy uid → name for display
    const invites = db.invites.map(i => ({
      ...i, usedByName: i.usedBy ? (db.users.find(u => u.id === i.usedBy) || {}).name || null : null
    }));
    json(res, 200, { invites, invite_only: INVITE_ONLY });
  },

  'POST /api/admin/invites/new': async (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    const body = await readBody(req);
    let code;
    // 16 hex chars = 64 bits, up from 8 chars / 32 bits. The app has no rate limiting by design
    // (that's the reverse proxy's job) and /api/register/options tells a caller whether a code is
    // good, so the code itself has to be the thing that isn't worth guessing. Codes already in
    // db.json keep working — validation is an exact string compare, never a length or format check.
    do { code = crypto.randomBytes(8).toString('hex').toUpperCase(); } while (db.invites.some(i => i.code === code));
    const invite = { code, note: String(body.note || '').slice(0, 60), createdBy: admin.id, created: new Date().toISOString() };
    db.invites.push(invite);
    saveDb();
    json(res, 200, { invite });
  },

  'POST /api/admin/invites/revoke': async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const body = await readBody(req);
    const inv = db.invites.find(i => i.code === String(body.code || '').toUpperCase());
    if (!inv) return json(res, 404, { error: 'no such code' });
    if (inv.usedBy) return json(res, 400, { error: 'already used — cannot revoke' });
    db.invites = db.invites.filter(i => i.code !== inv.code);
    saveDb();
    json(res, 200, { ok: true });
  },

  /* ---------- faturamento (usuário) ---------- */
  // Status da assinatura do perfil autenticado. Aberto com 401/200 — nunca bloqueado,
  // é justamente a tela que um vencido precisa ver.
  'GET /api/billing/status': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    json(res, 200, {
      billing: { ...billing.meBilling(user), pending: !!billing.pendingPayment(db, user.id) },
      config: billing.publicBilling()
    });
  },

  // Abre uma cobrança mensal. 'mp' (Mercado Pago) devolve um init_point para redirecionar;
  // 'pix' devolve a chave para pagamento manual — o painel aprova depois de conferir.
  'POST /api/billing/checkout': async (req, res) => {
    const user = readSession(req);
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
        saveDb();
        return json(res, 502, { error: 'falha ao criar cobrança no Mercado Pago' });
      }
    } else {
      payment = billing.createPayment(db, user.id, billing.PRICE, 'pix');
    }
    saveDb();
    json(res, 200, { payment, ...(payment.initPoint ? { initPoint: payment.initPoint } : {}), ...(billing.CHECKOUT_METHOD === 'pix' ? { pix: { key: billing.PIX_KEY, holder: billing.PIX_HOLDER, amount: billing.PRICE, currency: billing.CURRENCY } } : {}) });
  },

  // Webhook do Mercado Pago. O corpo nunca é confiado de olhos fechados: buscamos o
  // pagamento na própria API do MP com o token do servidor e só aprovamos se ele
  // disser 'approved' E o external_reference bater com uma cobrança pend nossa.
  'POST /api/billing/webhook': async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const body = await readBody(req).catch(() => ({}));
    const mpPaymentId = body?.data?.id || url.searchParams.get('data.id') || url.searchParams.get('id');
    if (!billing.MP_TOKEN || !mpPaymentId) return json(res, 200, { ok: true });   // 200 para o MP parar de reenviar
    try {
      const mp = await billing.mpFetchPayment(billing.MP_TOKEN, mpPaymentId);
      if (mp.status !== 'approved' || !mp.external_reference) return json(res, 200, { ok: true, ignored: mp.status });
      const local = (db.payments || []).find(p => p.id === mp.external_reference);
      if (!local || local.status !== 'pending') return json(res, 200, { ok: true, ignored: 'no pending payment' });
      local.mpPaymentId = String(mp.id);
      local.paidAmount = mp.transaction_amount;
      const u = billing.approvePayment(db, local.id, { by: 'mercadopago' });
      saveDb();
      if (u) sendPush(u.id, { title: `${billing.BRAND}`, body: 'Pagamento aprovado — bom treino! 💪', tag: 'billing' });
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
    const ip = req.socket?.remoteAddress || '?';
    const key = billing.attemptsKey(ip, username);
    if (panelRateLimited(key)) return json(res, 429, { error: 'muitas tentativas — aguarde alguns minutos' });
    if (!db.admins.length) return json(res, 403, { error: 'painel não configurado — defina ADMIN_USERNAME e ADMIN_PASSWORD no ambiente' });
    const admin = db.admins.find(a => a.username === username);
    if (!admin || !billing.verifyPassword(String(body.password || ''), admin.salt, admin.hash))
      return json(res, 401, { error: 'usuário ou senha incorretos' });
    panelAttempts.delete(key);
    json(res, 200, { ok: true, username: admin.username }, { 'Set-Cookie': panelCookie(billing.makePanelToken(admin.id, SECRET, undefined, Date.now(), admin.pnlSv || 0)) });
  },

  // Logout do painel bumpa a versão do admin: todo token emitido antes deixa de verificar,
  // mesmo que uma cópia do cookie tenha escapado.
  'POST /api/panel/logout': async (req, res) => {
    const admin = readPanelSession(req);
    if (admin) { admin.pnlSv = (admin.pnlSv || 0) + 1; saveDb(); }
    json(res, 200, { ok: true }, { 'Set-Cookie': panelClearCookie });
  },

  'GET /api/panel/me': async (req, res) => {
    const admin = requirePanel(req, res); if (!admin) return;
    json(res, 200, { username: admin.username });
  },

  // Visão geral: contagens por status + receita dos últimos 30 dias.
  'GET /api/panel/overview': async (req, res) => {
    const admin = requirePanel(req, res); if (!admin) return;
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
    const admin = requirePanel(req, res); if (!admin) return;
    const now = Date.now();
    const users = db.users.map(u => {
      const S = readState(u.id) || {};
      const workouts = S.workouts || [];
      const pend = billing.pendingPayment(db, u.id);
      return {
        id: u.id, name: u.name, created: u.created || null, disabled: !!u.disabled,
        billing: { ...billing.billingStatus(u, now), status2: u.billing?.status || null, note: u.billing?.note || null, pendingId: pend ? pend.id : null, pendingMethod: pend ? pend.method : null },
        workouts: workouts.length,
        lastWorkout: workouts.length ? workouts[workouts.length - 1].d : null,
        lastSync: S._ts || null
      };
    });
    json(res, 200, { users, now });
  },

  'GET /api/panel/payments': async (req, res) => {
    const admin = requirePanel(req, res); if (!admin) return;
    const payments = (db.payments || []).slice().reverse().map(p => ({
      ...p, userName: (db.users.find(u => u.id === p.userId) || {}).name || '(perfil removido)'
    }));
    json(res, 200, { payments });
  },

  'POST /api/panel/user/free': async (req, res) => {
    const admin = requirePanel(req, res); if (!admin) return;
    const body = await readBody(req);
    const u = db.users.find(x => x.id === body.id);
    if (!u) return json(res, 404, { error: 'no such user' });
    billing.grantFree(u, !!body.free, body.free ? 'isento pelo painel' : null);
    saveDb();
    json(res, 200, { ok: true, id: u.id, free: !!body.free, billing: billing.billingStatus(u) });
  },

  'POST /api/panel/user/disable': async (req, res) => {
    const admin = requirePanel(req, res); if (!admin) return;
    const body = await readBody(req);
    const u = db.users.find(x => x.id === body.id);
    if (!u) return json(res, 404, { error: 'no such user' });
    u.disabled = !!body.disabled;
    if (u.disabled) presence.delete(u.id);
    saveDb();
    json(res, 200, { ok: true, id: u.id, disabled: u.disabled });
  },

  // Cortesia manual: estende o período pago em N dias (não afeta isentos).
  'POST /api/panel/user/extend': async (req, res) => {
    const admin = requirePanel(req, res); if (!admin) return;
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
    saveDb();
    json(res, 200, { ok: true, billing: billing.billingStatus(u) });
  },

  'POST /api/panel/payment/approve': async (req, res) => {
    const admin = requirePanel(req, res); if (!admin) return;
    const body = await readBody(req);
    const u = billing.approvePayment(db, String(body.id || ''), { by: admin.username });
    if (!u) return json(res, 404, { error: 'cobrança pendente não encontrada' });
    saveDb();
    sendPush(u.id, { title: `${billing.BRAND}`, body: 'Pagamento aprovado — bom treino! 💪', tag: 'billing' });
    json(res, 200, { ok: true, billing: billing.billingStatus(u) });
  },

  'POST /api/panel/payment/reject': async (req, res) => {
    const admin = requirePanel(req, res); if (!admin) return;
    const body = await readBody(req);
    const p = billing.rejectPayment(db, String(body.id || ''), { by: admin.username });
    if (!p) return json(res, 404, { error: 'cobrança pendente não encontrada' });
    saveDb();
    json(res, 200, { ok: true });
  },

  /* ---------- AI Coach ---------- */
  // Routes live in coach/routes.js and are handed the helpers above rather than importing
  // them: they are closures over db and SECRET, and passing them in keeps that module free of
  // a cycle. Every one of them is inert while the feature is unconfigured.
  ...coachRoutes({ json, readBody, readSession, requireAdmin })
};

/* ---------- Coach: boot recovery, notifications, scheduled reviews ---------- */
// A job that was running when the process died is not coming back; say so rather than leaving
// a spinner that never resolves.
coachJobs.recoverOnBoot();
// A ready proposal is the one Coach event worth a notification. Failures and "nothing to
// change" stay silent on purpose (FR-38/E4).
coachJobs.setProposalHook((uid, pending) => {
  const n = (pending?.changes || []).length;
  if (!n) return;
  sendPush(uid, {
    title: 'Your Coach has been reading',
    body: n === 1 ? '1 suggestion after this week' : `${n} suggestions after this week`,
    tag: 'coach-proposal', url: '#/coach'
  });
});
startCadence({ users: () => db.users, userNow });

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const key = req.method + ' ' + url.pathname;
  const handler = routes[key];
  if (!handler) return json(res, 404, { error: 'not found' });
  try { await handler(req, res); }
  catch (e) {
    console.error(key, e);
    if (!res.headersSent) json(res, 500, { error: 'server error' });
  }
}).listen(PORT, () => console.log(`gym-api on :${PORT} (rpID=${RP_ID}, origin=${ORIGIN})`));
