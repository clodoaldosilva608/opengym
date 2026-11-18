/* ÚNICA função serverless da API do openGym.
   O vercel.json reescreve /api/<caminho> → /api/api?__p=<caminho> (o resto da
   query original é anexado automaticamente pela Vercel), e este arquivo delega
   tudo ao roteador em serverless/core.js. Uma função só cabe no limite de 12
   funções do plano Hobby e mantém o roteamento num lugar só.  */
import handler from '../serverless/core.js';
export default handler;
