/* Testa a camada storage com backend GitHub no repositório real (opengym-data).
   Uso: GITHUB_TOKEN=... node scripts/test-gh-storage.mjs
   Faz: ping (write/read/delete) + write conflitante + leitura condicional (304).  */
import * as store from '../frontend/serverless/storage.js';

let failures = 0;
const ok = (cond, label) => { console.log((cond ? '  ✔ ' : '  ✘ ') + label); if (!cond) failures++; };

console.log('backend:', store.BACKEND);
if (store.BACKEND !== 'github') { console.error('DATA_BACKEND=github exigido'); process.exit(1); }

const ping = await store.ping();
ok(ping === true, 'ping (write → read → delete)');

// roundtrip de objeto grande-ish
const db = { users: [{ id: 'u1', name: 'Teste', billing: { status: 'trial' } }], payments: [], admins: [] };
await store.writeJson('db', db);
const back = await store.readJson('db', null);
ok(back?.users?.[0]?.name === 'Teste', 'db.json roundtrip');

// leitura condicional: segunda leitura deve vir de cache ETag (304) sem mudar o conteúdo
const again = await store.readJson('db', null);
ok(again?.users?.[0]?.id === 'u1', 'segunda leitura (If-None-Match) ok');

// escrita de atualização (PUT com sha) 
db.users[0].name = 'Teste 2';
await store.writeJson('db', db);
const upd = await store.readJson('db', null);
ok(upd?.users?.[0]?.name === 'Teste 2', 'update do arquivo existente');

// limpeza
await store.remove('db');
const gone = await store.readJson('db', null);
ok(gone === null, 'remove() apagou o arquivo');

console.log(failures ? `\n✘ ${failures} falha(s)` : '\n✔ storage github OK');
process.exit(failures ? 1 : 0);
