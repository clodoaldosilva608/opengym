/* Harness local da edição serverless: sobe core.js num servidor http de verdade
   para poder rodar o smoke test igual ao de produção. Uso:
     node scripts/dev-serverless.mjs                    (porta 3300)
     PORT=3400 node scripts/dev-serverless.mjs          */
import http from 'node:http';
import handler from '../frontend/serverless/core.js';

const PORT = +(process.env.PORT || 3300);
http.createServer((req, res) => handler(req, res)).listen(PORT, () => {
  console.log(`dev-serverless on :${PORT}`);
});
