/* Harness local da edição serverless: sobe core.js num servidor http de verdade
   e simula o rewrite de produção do vercel.json (/api/<sub> → /api/api?__p=<sub>,
   query original anexada), para o smoke testar o mesmo caminho de código da Vercel.
   Uso: PORT=3300 node scripts/dev-serverless.mjs  */
import http from 'node:http';
import handler from '../frontend/serverless/core.js';

const PORT = +(process.env.PORT || 3300);
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.startsWith('/api/') && u.pathname !== '/api/api') {
    const sub = u.pathname.slice('/api/'.length);
    req.url = '/api/api?__p=' + encodeURIComponent(sub) + (u.search ? '&' + u.search.slice(1) : '');
  }
  handler(req, res);
}).listen(PORT, () => {
  console.log(`dev-serverless on :${PORT}`);
});
