import test from 'node:test';
import assert from 'node:assert/strict';
import * as b from '../billing.js';

const DAY = 86400000;
const iso = t => new Date(t).toISOString();
const user = billing => ({ id: 'u1', name: 'Teste', billing });

/* ---------------- status / acesso ---------------- */

test('um perfil sem campo billing está vencido (fail closed)', () => {
  assert.equal(b.billingStatus({ id: 'u1' }).code, 'overdue');
  assert.equal(b.hasAccess({ id: 'u1' }), false);
});

test('trial válido dá acesso; vencido não', () => {
  const u = user(b.newUserBilling(7, Date.now()));
  assert.equal(b.billingStatus(u).code, 'trial');
  assert.equal(b.hasAccess(u), true);
  const expired = user({ status: 'trial', trialEndsAt: iso(Date.now() - DAY) });
  assert.equal(b.billingStatus(expired).code, 'overdue');
  assert.equal(b.hasAccess(expired), false);
});

test('período pago válido dá acesso; expirado não', () => {
  const u = user({ status: 'active', periodEnd: iso(Date.now() + 10 * DAY) });
  assert.equal(b.billingStatus(u).code, 'active');
  const past = user({ status: 'active', periodEnd: iso(Date.now() - DAY) });
  assert.equal(b.billingStatus(past).code, 'overdue');
  assert.equal(b.hasAccess(past), false);
});

test('isento tem acesso mesmo sem período ou trial', () => {
  const u = user({ status: 'free', free: true });
  assert.equal(b.billingStatus(u).code, 'free');
  assert.equal(b.hasAccess(u), true);
});

test('status ativo com periodEnd ausente não dá acesso', () => {
  assert.equal(b.billingStatus(user({ status: 'active' })).code, 'overdue');
});

/* ---------------- migração ---------------- */

test('perfis pré-existentes viram isentos; arrays de payments/admins são criados', () => {
  const db = { users: [{ id: 'old1', name: 'Dono' }, { id: 'old2', billing: { status: 'active', periodEnd: iso(Date.now() + DAY) } }] };
  const changed = b.migrateBilling(db, 7);
  assert.equal(db.users[0].billing.free, true, 'dono fica isento');
  assert.equal(db.users[0].billing.grandfathered, true);
  assert.equal(db.users[1].billing.status, 'active', 'quem já tem billing não é tocado');
  assert.deepEqual(db.payments, []);
  assert.deepEqual(db.admins, []);
  assert.ok(changed >= 1);
  // idempotente
  const again = b.migrateBilling(db, 7);
  assert.equal(again, 0);
});

test('novo usuário entra em trial com o fim correto; trial 0 já nasce vencido', () => {
  const now = Date.now();
  const b1 = b.newUserBilling(7, now);
  assert.equal(b1.status, 'trial');
  assert.equal(+new Date(b1.trialEndsAt), now + 7 * DAY);
  const b0 = b.newUserBilling(0, now);
  assert.equal(b.billingStatus({ billing: b0 }).code, 'overdue');
});

/* ---------------- pagamentos ---------------- */

test('criar → aprovar pagamento estende o período a partir de agora', () => {
  const now = Date.now();
  const db = { users: [user(b.newUserBilling(0, now))], payments: [] };
  const p = b.createPayment(db, 'u1', 14.9, 'pix', {}, now);
  assert.equal(p.status, 'pending');
  assert.equal(b.pendingPayment(db, 'u1').id, p.id);
  const u = b.approvePayment(db, p.id, { by: 'admin', periodDays: 30 }, now + 1000);
  assert.equal(u.billing.status, 'active');
  assert.ok(+new Date(u.billing.periodEnd) > now + 29 * DAY);
  assert.equal(db.payments[0].status, 'approved');
  assert.equal(db.payments[0].approvedBy, 'admin');
});

test('aprovar prorroga a partir do fim do período atual, não do passado', () => {
  const now = Date.now();
  const u = user({ status: 'active', periodEnd: iso(now + 10 * DAY) });
  const db = { users: [u], payments: [] };
  const p = b.createPayment(db, 'u1', 14.9, 'pix', {}, now);
  b.approvePayment(db, p.id, { periodDays: 30 }, now);
  assert.ok(+new Date(u.billing.periodEnd) >= now + 39 * DAY, '30 dias sobre os 10 restantes');
});

test('aprovar/rejeitar só funciona em pagamento pendente', () => {
  const db = { users: [user(b.newUserBilling(0))], payments: [] };
  const p = b.createPayment(db, 'u1', 14.9, 'pix');
  b.approvePayment(db, p.id);
  assert.equal(b.approvePayment(db, p.id), null, 'não aprova duas vezes');
  assert.equal(b.rejectPayment(db, p.id), null, 'não rejeita o que já foi aprovado');
  assert.equal(b.rejectPayment(db, 'pay_naoexiste'), null);
});

test('só existe um pagamento pendente por usuário (o primeiro aberto vence; checkout é idempotente)', () => {
  const db = { users: [user(b.newUserBilling(0))], payments: [] };
  const first = b.createPayment(db, 'u1', 14.9, 'pix');
  b.createPayment(db, 'u1', 14.9, 'pix');
  assert.equal(b.pendingPayment(db, 'u1').id, first.id);
});

test('rejectPayment marca reprovado com responsável', () => {
  const db = { users: [user(b.newUserBilling(0))], payments: [] };
  const p = b.createPayment(db, 'u1', 14.9, 'pix');
  const r = b.rejectPayment(db, p.id, { by: 'dono' });
  assert.equal(r.status, 'rejected');
  assert.equal(r.approvedBy, 'dono');
});

/* ---------------- isenção / extensão ---------------- */

test('conceder e revogar isenção pelo painel', () => {
  const u = user(b.newUserBilling(0));
  b.grantFree(u, true, 'amigo');
  assert.equal(b.billingStatus(u).code, 'free');
  b.grantFree(u, false);
  assert.equal(b.billingStatus(u).code, 'overdue', 'sem período pago, revogar isenção vence o perfil');
});

/* ---------------- painel admin ---------------- */

test('hash/verify de senha com scrypt', () => {
  const { salt, hash } = b.hashPassword('s3nhaforte');
  assert.notEqual(hash, 's3nhaforte');
  assert.equal(b.verifyPassword('s3nhaforte', salt, hash), true);
  assert.equal(b.verifyPassword('errada', salt, hash), false);
  assert.equal(b.verifyPassword('s3nhaforte', 'salterrado', hash), false);
});

test('token do painel: cria, lê, expira e rejeita alteração', () => {
  const S1 = 'a'.repeat(64), S2 = 'b'.repeat(64);
  const tok = b.makePanelToken('adm1', S1, 2);
  assert.equal(b.readPanelToken(tok, S1).adminId, 'adm1');
  assert.equal(b.readPanelToken(tok, S1).ver, 0);
  assert.equal(b.readPanelToken(b.makePanelToken('adm1', S1, 2, Date.now(), 3), S1).ver, 3, 'versão carregada no token');
  assert.equal(b.readPanelToken(tok, S2), null, 'secret diferente rejeita');
  const old = b.makePanelToken('adm1', S1, 2, Date.now() - 3 * DAY);
  assert.equal(b.readPanelToken(old, S1), null, 'expirado rejeita');
  assert.equal(b.readPanelToken('lixo', S1), null);
  assert.equal(b.readPanelToken(tok.slice(0, -2) + 'zz', S1), null, 'mac alterado rejeita');
  assert.equal(b.readPanelToken('user:adm1:0:' + (Date.now() + 1000) + '.' + 'x'.repeat(43), S1), null, 'payload de outro tipo rejeita');
  assert.equal(b.readPanelToken('admin:adm1:0:naoehnumero.' + 'x'.repeat(43), S1), null, 'exp malformado rejeita');
});

/* ---------------- config pública ---------------- */

test('config pública expõe preço/trial sem nada sensível', () => {
  const pub = b.publicBilling();
  assert.equal(typeof pub.price, 'number');
  assert.ok(pub.price > 0);
  assert.equal(typeof pub.trialDays, 'number');
  assert.ok(!JSON.stringify(pub).toLowerCase().includes('token'));
});
