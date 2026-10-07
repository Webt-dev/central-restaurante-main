import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useTempEnvironment } from './helpers.js';

useTempEnvironment();

const { initDatabase } = await import('../src/config/database.js');
const { AuthService } = await import('../src/services/AuthService.js');
const { resolveSession } = await import('../src/middlewares/authMiddleware.js');
const { verifyToken } = await import('../src/utils/crypto.js');
const { resetThrottle } = await import('../src/services/loginThrottle.js');
const { verifyAuditChain } = await import('../src/services/AuditService.js');
const { db } = await import('../src/config/database.js');

initDatabase();

test('instalação nova não tem nenhum usuário padrão', () => {
  assert.equal(AuthService.needsSetup(), true);
  assert.equal((db.prepare('SELECT COUNT(*) as c FROM users').get() as { c: number }).c, 0);
});

test('configuração inicial exige senha forte e só roda uma vez', async () => {
  await assert.rejects(AuthService.setup('Dono', 'dono', '1234567', '127.0.0.1'), /8 caracteres/);
  const { token, user } = await AuthService.setup('Dono', 'dono', 'senha-forte-1', '127.0.0.1');
  assert.equal(user.role, 'ADMIN');
  assert.ok(resolveSession(token));
  await assert.rejects(AuthService.setup('Outro', 'outro', 'senha-forte-2', '127.0.0.1'), /já foi configurado/);
});

test('token com assinatura ou cabeçalho alterado é recusado', async () => {
  const { token } = await AuthService.login('dono', 'senha-forte-1', '127.0.0.1');
  const [header, body] = token.split('.');
  assert.equal(verifyToken(`${header}.${body}.assinatura-falsa`), null);
  const noneHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  assert.equal(verifyToken(`${noneHeader}.${body}.`), null);
});

test('login bloqueia após 5 senhas erradas', async () => {
  resetThrottle();
  await AuthService.createUser('Garçom', 'garcom1', 'WAITER', 'garcom-1');
  for (let i = 0; i < 5; i++) {
    await assert.rejects(AuthService.login('garcom1', 'errada', '10.0.0.5'), /inválidos/);
  }
  await assert.rejects(AuthService.login('garcom1', 'garcom-1', '10.0.0.5'), /Muitas tentativas/);
  // Outro IP não é afetado pelo bloqueio da conta neste IP.
  assert.ok((await AuthService.login('garcom1', 'garcom-1', '10.0.0.6')).token);
});

test('desativar usuário derruba a sessão na hora', async () => {
  resetThrottle();
  const { token, user } = await AuthService.login('garcom1', 'garcom-1', '127.0.0.1');
  assert.ok(resolveSession(token));
  const admin = db.prepare("SELECT id FROM users WHERE username = 'dono'").get() as { id: string };
  AuthService.updateUser(admin.id, user.id, { name: user.name, role: 'WAITER', active: false });
  assert.equal(resolveSession(token), null);
  await assert.rejects(AuthService.login('garcom1', 'garcom-1', '127.0.0.1'), /inválidos/);
});

test('não permite ficar sem administrador ativo', () => {
  const admin = db.prepare("SELECT id FROM users WHERE username = 'dono'").get() as { id: string };
  assert.throws(() => AuthService.updateUser('outro-id', admin.id, { name: 'Dono', role: 'WAITER', active: true }), /pelo menos um administrador/);
});

test('trilha de auditoria é íntegra e não aceita alteração', () => {
  assert.equal(verifyAuditChain(), null);
  assert.throws(() => db.prepare("UPDATE audit_log SET action = 'x'").run(), /somente inclusão/);
  assert.throws(() => db.prepare('DELETE FROM audit_log').run(), /somente inclusão/);
});

test('senha de fábrica gera token que só serve para trocar a senha', async () => {
  resetThrottle();
  // Simula uma instalação antiga atualizada, ainda com a senha publicada no manual.
  const legacy = await AuthService.createUser('Caixa Antigo', 'caixa', 'CASHIER', 'caixa-temporaria');
  const { hashPassword } = await import('../src/utils/crypto.js');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword('caixa123'), legacy.id);

  const login = await AuthService.login('caixa', 'caixa123', '127.0.0.1');
  assert.equal(login.mustChangePassword, true);
  assert.equal(resolveSession(login.token)?.mcp, true);

  const changed = await AuthService.changeOwnCredentials(legacy.id, { currentPassword: 'caixa123', newPassword: 'nova-senha-1' });
  assert.equal(resolveSession(changed.token)?.mcp, undefined);
  assert.equal(resolveSession(login.token), null);
});
