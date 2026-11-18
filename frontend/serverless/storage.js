/* storage.js — camada de persistência da edição serverless do openGym.
   Hospedagem 100% gratuita: em vez de um disco de um servidor dedicado, os
   "arquivos JSON" (db, estados por usuário, desafios WebAuthn, timers) vivem
   como arquivos num REPOSITÓRIO PRIVADO do GitHub, acessados pela Contents API.

   Backends:
     github — Contents API (DATA_BACKEND=github ou GITHUB_TOKEN+GITHUB_REPO setados)
     fs     — disco local (DATA_DIR), para dev/testes

   Detalhes que importam:
     - Leituras condicionais (If-None-Match / ETag): um 304 do GitHub não conta
       contra o rate limit de 5000 req/h, então reler "só para conferir frescor"
       é barato. Isso mantém os dados frescos entre instâncias sem estourar limite.
     - Escritas são serializadas dentro da instância (fila de promessas) e fazem
       retry uma vez em caso de conflito de sha (409/422) — última escrita ganha,
       mesmo modelo de consistência do MVP (multi-instância: last-write-wins).
     - remove() apaga o arquivo (desafios WebAuthn são consumidos e apagados).  */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const BACKEND =
  (process.env.DATA_BACKEND || '').toLowerCase() ||
  (process.env.GITHUB_TOKEN && process.env.GITHUB_REPO ? 'github' : 'fs');

const GH_TOKEN = process.env.GITHUB_TOKEN || '';
const GH_REPO = process.env.GITHUB_REPO || '';
const GH_BRANCH = process.env.GITHUB_BRANCH || 'main';
const GH_API = GH_REPO ? 'https://api.github.com/repos/' + GH_REPO + '/contents/' : '';
const GH_PREFIX = process.env.GITHUB_DATA_PREFIX || 'data/';
const DATA_DIR = process.env.DATA_DIR || '/tmp/opengym-data';

const GH_HEADERS = {
  Authorization: 'Bearer ' + GH_TOKEN,
  Accept: 'application/vnd.github+json',
  'Content-Type': 'application/json',
  'User-Agent': 'opengym-api'
};

/* cache de ETag por arquivo: { etag, content } — 304 devolve o cache */
const etagCache = new Map();

/* fila de escritas: garante ordem e evita PUT paralelo com sha obsoleto */
let writeQueue = Promise.resolve();

async function ghGet(name) {
  const cached = etagCache.get(name);
  const url = GH_API + GH_PREFIX + name + '?ref=' + encodeURIComponent(GH_BRANCH);
  const headers = { ...GH_HEADERS, ...(cached?.etag ? { 'If-None-Match': cached.etag } : {}) };
  const r = await fetch(url, { headers });
  if (r.status === 304 && cached) return { content: cached.content, sha: cached.sha };
  if (r.status === 404) { etagCache.delete(name); return null; }
  if (!r.ok) {
    if (r.status === 403) throw new Error('github rate limit ou acesso negado (HTTP 403)');
    throw new Error('github GET ' + r.status);
  }
  const j = await r.json();
  if (Array.isArray(j)) return null;                       // path virou diretório — não esperado
  const content = j.content ? Buffer.from(j.content, 'base64').toString('utf8') : '';
  const etag = r.headers.get('etag');
  if (etag) etagCache.set(name, { etag, content, sha: j.sha });
  return { content, sha: j.sha };
}

async function ghPutOnce(name, content, sha) {
  const r = await fetch(GH_API + GH_PREFIX + name, {
    method: 'PUT', headers: GH_HEADERS,
    body: JSON.stringify({
      message: 'opengym: ' + name,
      content: Buffer.from(content, 'utf8').toString('base64'),
      branch: GH_BRANCH,
      ...(sha ? { sha } : {})
    })
  });
  if (r.ok) {
    const j = await r.json().catch(() => ({}));
    return j.content?.sha || null;
  }
  return { status: r.status };
}

async function ghPut(name, content) {
  let sha = etagCache.get(name)?.sha;
  let out = await ghPutOnce(name, content, sha);
  if (out && out.status) {                                  // conflito (409/422) → re-GET e sobrescreve
    if (out.status !== 409 && out.status !== 422) throw new Error('github PUT ' + out.status);
    const fresh = await ghGet(name).catch(() => null);
    out = await ghPutOnce(name, content, fresh?.sha);
    if (out && out.status) throw new Error('github PUT ' + out.status + ' após retry');
  }
  etagCache.set(name, { etag: null, content, sha: out || undefined });
}

async function ghDelete(name) {
  const sha = etagCache.get(name)?.sha || (await ghGet(name))?.sha;
  if (!sha) return;                                         // nada para apagar
  const r = await fetch(GH_API + GH_PREFIX + name, {
    method: 'DELETE', headers: GH_HEADERS,
    body: JSON.stringify({ message: 'opengym: rm ' + name, branch: GH_BRANCH, sha })
  });
  if (r.ok || r.status === 404) etagCache.delete(name);
}

/* ---------------- backend fs (dev/testes) ---------------- */
const fsPath = name => path.join(DATA_DIR, name);
function fsRead(name) {
  try { return fs.readFileSync(fsPath(name), 'utf8'); } catch { return null; }
}
function fsWrite(name, content) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = fsPath(name) + '.tmp';
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, fsPath(name));
}
function fsDelete(name) { try { fs.unlinkSync(fsPath(name)); } catch { /* já foi */ } }

/* ---------------- API pública ---------------- */
export async function readText(name) {
  if (BACKEND === 'github') { const r = await ghGet(name); return r ? r.content : null; }
  return fsRead(name);
}
export async function writeText(name, content) {
  if (BACKEND === 'github') {
    writeQueue = writeQueue.then(() => ghPut(name, content));
    await writeQueue;
    return;
  }
  fsWrite(name, content);
}
export async function remove(name) {
  if (BACKEND === 'github') {
    writeQueue = writeQueue.then(() => ghDelete(name));
    await writeQueue;
    return;
  }
  fsDelete(name);
}
export async function readJson(name, fallback = null) {
  const raw = await readText(name);
  if (raw == null) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}
export async function writeJson(name, obj) {
  return writeText(name, JSON.stringify(obj));
}
/* teste rápido de sanidade — usado pelo smoke da hospedagem */
export async function ping() {
  const name = 'ping-' + crypto.randomBytes(4).toString('hex');
  const stamp = new Date().toISOString();
  await writeJson(name, { stamp, backend: BACKEND });
  const back = await readJson(name, null);
  await remove(name);
  return back?.stamp === stamp;
}
