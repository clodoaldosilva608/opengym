/* Função serverless catch-all da API do openGym.
   Todos os endpoints /api/* caem aqui; o roteamento vive em serverless/core.js.  */
import handler from '../serverless/core.js';
export default handler;
