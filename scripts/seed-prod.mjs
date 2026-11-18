/* Semeia/limpa o banco de dados no repo privado (para e2e contra produção).
   Uso:
     node scripts/seed-prod.mjs seed     — cria usuário u_e2e vencido+admin
     node scripts/seed-prod.mjs clean    — reseta db e remove arquivos de teste  */
import * as store from '../frontend/serverless/storage.js';

const cmd = process.argv[2] || '';
if (store.BACKEND !== 'github') { console.error('exige DATA_BACKEND=github'); process.exit(1); }

if (cmd === 'seed') {
  const past = new Date(Date.now() - 3 * 86400000).toISOString();
  const db = {
    users: [{
      id: 'u_e2e', name: 'E2E Temporário', admin: true, created: past,
      billing: { status: 'trial', free: false, trialEndsAt: past, periodEnd: null, grandfathered: false, note: null }
    }],
    creds: [], subs: [], invites: [], payments: [], admins: []
  };
  await store.writeJson('db', db);
  console.log('db semeado: u_e2e (overdue, admin)');
} else if (cmd === 'clean') {
  await store.writeJson('db', { users: [], creds: [], subs: [], invites: [], payments: [], admins: [] });
  for (const n of ['state-u_e2e', 'reminders', 'timers', 'vapid', 'secret']) {
    // vapid e secret são mantidos (valem para usuários reais futuros); só apaga se for teste
    if (n === 'vapid' || n === 'secret') continue;
    try { await store.remove(n); } catch { /* */ }
  }
  console.log('db resetado e arquivos de teste removidos');
} else {
  console.error('uso: node scripts/seed-prod.mjs seed|clean');
  process.exit(1);
}
