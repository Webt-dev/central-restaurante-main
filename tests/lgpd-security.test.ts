import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { useTempEnvironment } from './helpers.js';

const dir = useTempEnvironment();

const { initDatabase, db } = await import('../src/config/database.js');
const { AuthService } = await import('../src/services/AuthService.js');
const { audit, verifyAuditChain } = await import('../src/services/AuditService.js');
const { maskCpf, maskEmail, maskPiiDeep } = await import('../src/utils/pii.js');
const { sanitize } = await import('../src/utils/logger.js');
const installCode = await import('../src/config/installCode.js');
const Lgpd = await import('../src/services/LgpdService.js');
const { encryptFile, decryptFile } = await import('../src/services/BackupCrypto.js');
const { createBackup, listBackups } = await import('../src/services/BackupService.js');
const { createRateLimiter } = await import('../src/middlewares/rateLimit.js');
const { buildCsp, inlineScriptHashes } = await import('../src/middlewares/securityHeaders.js');
const { sanitizeForBroadcast } = await import('../src/sockets/socketManager.js');
const { default: authRoutes } = await import('../src/routes/auth.routes.js');
const { errorHandler } = await import('../src/middlewares/errorHandler.js');
const { default: express } = await import('express');

initDatabase();

const CPF = '529.982.247-25';
const CPF_DIGITS = '52998224725';

// ------------------------------------------------------------ máscaras

test('máscaras de CPF e e-mail', () => {
  assert.equal(maskCpf(`cliente ${CPF} e ${CPF_DIGITS}`), 'cliente ***.***.***-25 e ***.***.***-25');
  assert.equal(maskEmail('fale com maria@exemplo.com.br'), 'fale com m***@exemplo.com.br');
  // CNPJ e chave de acesso não podem ser confundidos com CPF
  assert.equal(maskCpf('11.222.333/0001-81'), '11.222.333/0001-81');
  assert.equal(maskCpf('35261011222333000181650010000000011123456780'), '35261011222333000181650010000000011123456780');
  const deep = maskPiiDeep({ cpf_consumidor: CPF_DIGITS, nested: [{ obs: `CPF ${CPF}` }] }) as any;
  assert.equal(deep.cpf_consumidor, '***.***.***-25');
  assert.equal(deep.nested[0].obs, 'CPF ***.***.***-25');
});

test('log mascara CPF, e-mail e continua mascarando segredos', () => {
  const out = sanitize(`pedido de ${CPF} (joao@x.com) password=abc123 Bearer tok.en`);
  assert.ok(!out.includes('529') && !out.includes('joao@') && !out.includes('abc123') && !out.includes('tok.en'));
});

test('auditoria nunca grava CPF e a cadeia de hash continua válida', () => {
  audit({
    action: 'teste.cpf', after: { cpf_consumidor: CPF_DIGITS, obs: `titular ${CPF}` },
    before: { email: 'fulano@dominio.com' }, reason: `pedido do CPF ${CPF}`
  });
  const row = db.prepare('SELECT * FROM audit_log WHERE action = ?').get('teste.cpf') as any;
  const all = `${row.before_json}${row.after_json}${row.reason}`;
  assert.ok(!all.includes('529') && !all.includes('fulano@'), all);
  assert.equal(verifyAuditChain(), null);
});

// ------------------------------------------------------------ socket

test('eventos em tempo real saem sem identificadores internos e sem CPF', () => {
  const out = sanitizeForBroadcast({
    id: 'o1', waiter_id: 'u1', offline_sync_id: 's1', cashier_session_id: 'c1',
    notes: `cpf ${CPF}`, items: [{ id: 'i1', notes: 'sem cebola' }]
  }) as any;
  assert.equal(out.waiter_id, undefined);
  assert.equal(out.offline_sync_id, undefined);
  assert.equal(out.cashier_session_id, undefined);
  assert.ok(!JSON.stringify(out).includes('529'));
  assert.equal(out.items[0].notes, 'sem cebola');
});

// ------------------------------------------------------------ setup com código

async function post(server: http.Server, body: unknown): Promise<{ status: number; json: any }> {
  const { port } = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/setup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  return { status: res.status, json: await res.json() };
}

test('setup exige o código de instalação (403 sem ele, 201 com ele, 409 depois)', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  app.use(errorHandler);
  const server = await new Promise<http.Server>(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const user = { name: 'Dono', username: 'dono', password: 'senha-forte-1' };
    const code = installCode.getInstallCode();
    assert.ok(fs.existsSync(installCode.installCodeFile()), 'código gravado na pasta de dados');

    assert.equal((await post(server, user)).status, 403);
    assert.equal((await post(server, { ...user, installCode: 'AAAA-BBBB-CCCC' })).status, 403);
    assert.equal(AuthService.needsSetup(), true);

    // digitação sem traços e em minúsculas também vale
    const ok = await post(server, { ...user, installCode: code.replace(/-/g, '').toLowerCase() });
    assert.equal(ok.status, 201);
    assert.ok(!fs.existsSync(installCode.installCodeFile()), 'código apagado após o setup');
    assert.equal((await post(server, { ...user, username: 'outro', installCode: code })).status, 409);
  } finally {
    server.close();
  }
});

test('código de instalação trava após 10 erros seguidos', () => {
  installCode.resetInstallCodeThrottle();
  let last = '';
  for (let i = 0; i < 10; i++) last = installCode.checkInstallCode('errado', '10.0.0.9');
  assert.equal(last, 'locked');
  assert.equal(installCode.checkInstallCode(installCode.getInstallCode(), '10.0.0.9'), 'locked');
  installCode.resetInstallCodeThrottle();
});

// ------------------------------------------------------------ cabeçalhos / rate limit

test('CSP é restritiva e libera só o hash do script inline do index.html', () => {
  const html = path.join(dir, 'index.html');
  fs.writeFileSync(html, '<html><script>var a=1;</script><script type="module" src="/x.js"></script></html>');
  const hashes = inlineScriptHashes(html);
  assert.equal(hashes.length, 1);
  const csp = buildCsp(hashes);
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self' 'sha256-/);
  assert.ok(!/script-src[^;]*unsafe-inline/.test(csp));
  assert.match(csp, /connect-src 'self' ws: wss:/);
  assert.match(csp, /img-src 'self' data:/);
  assert.match(csp, /frame-ancestors 'none'/);
});

test('rate limit responde 429 ao passar do teto', () => {
  const limiter = createRateLimiter({ authenticatedPerMinute: 3, anonymousPerMinute: 2 });
  const run = (auth: boolean) => {
    let status = 200;
    let nexted = false;
    const res: any = { setHeader() {}, status(s: number) { status = s; return this; }, json() {} };
    limiter({ headers: auth ? { authorization: 'Bearer x' } : {}, ip: '1.2.3.4' } as any, res, () => { nexted = true; });
    return { status, nexted };
  };
  assert.equal(run(true).nexted, true);
  run(true); run(true);
  assert.equal(run(true).status, 429);
  assert.equal(run(false).nexted, true);
  run(false);
  assert.equal(run(false).status, 429);
});

// ------------------------------------------------------------ LGPD

function insertDoc(id: string, status: string, numero: number, cpf: string | null, createdAt = "datetime('now','localtime')") {
  const payload = JSON.stringify({ numero, itens: [], ...(cpf ? { cpf_consumidor: cpf } : {}) });
  db.prepare(`
    INSERT INTO fiscal_documents (id, checkout_id, provider, ambiente, serie, numero, status, valor_total, payload_json, created_at)
    VALUES (?, ?, 'simulacao', 2, 1, ?, ?, 10, ?, ${createdAt})
  `).run(id, `chk-${id}`, numero, status, payload);
}
const payloadOf = (id: string) => JSON.parse((db.prepare('SELECT payload_json FROM fiscal_documents WHERE id = ?').get(id) as any).payload_json);

test('LGPD: consulta lista as notas do titular com CPF mascarado', () => {
  insertDoc('d-aut', 'AUTORIZADO', 1, CPF_DIGITS);
  insertDoc('d-rej', 'REJEITADO', 2, CPF_DIGITS);
  insertDoc('d-outro', 'AUTORIZADO', 3, '11144477735');
  const r = Lgpd.consultarTitular(CPF);
  assert.equal(r.cpf, '***.***.***-25');
  assert.deepEqual(r.notas.map(n => n.id).sort(), ['d-aut', 'd-rej']);
  assert.equal(r.notas.find(n => n.id === 'd-rej')!.anonimizavel, true);
  assert.equal(r.notas.find(n => n.id === 'd-aut')!.anonimizavel, false);
  assert.throws(() => Lgpd.consultarTitular('111.111.111-11'), /CPF/);
});

test('LGPD: anonimiza só o que não tem guarda fiscal e explica a recusa', () => {
  const r = Lgpd.anonimizarTitular(CPF);
  assert.deepEqual(r.anonimizados, ['d-rej']);
  assert.equal(r.recusados.length, 1);
  assert.match(r.recusados[0]!.base_legal, /art\. 7º, II/);
  assert.equal(payloadOf('d-rej').cpf_consumidor, undefined);
  assert.equal(payloadOf('d-aut').cpf_consumidor, CPF_DIGITS);

  // Só sobrou nota autorizada: recusa total (409) e a nota segue intacta.
  assert.throws(() => Lgpd.anonimizarTitular(CPF), (e: any) => e.statusCode === 409 && /5 anos/.test(e.message));
  assert.equal(payloadOf('d-aut').cpf_consumidor, CPF_DIGITS);
  assert.throws(() => Lgpd.anonimizarTitular('390.533.447-05'), (e: any) => e.statusCode === 404);
});

test('LGPD: retenção remove o CPF de notas com mais de 5 anos + 60 dias', () => {
  insertDoc('d-velha', 'AUTORIZADO', 10, CPF_DIGITS, "datetime('now','localtime','-5 years','-70 days')");
  insertDoc('d-quase', 'AUTORIZADO', 11, CPF_DIGITS, "datetime('now','localtime','-5 years','-30 days')");
  assert.equal(Lgpd.executarRetencao(), 1);
  assert.equal(payloadOf('d-velha').cpf_consumidor, undefined);
  assert.ok(payloadOf('d-velha').cpf_anonimizado_em);
  assert.equal(payloadOf('d-quase').cpf_consumidor, CPF_DIGITS);
  assert.equal(Lgpd.executarRetencao(), 0);
  assert.equal(verifyAuditChain(), null);
});

// ------------------------------------------------------------ backup criptografado

function makeSqlite(file: string, value: string) {
  const d = new Database(file);
  d.exec('CREATE TABLE t (v TEXT)');
  d.prepare('INSERT INTO t VALUES (?)').run(value);
  d.close();
}

test('backup criptografado: ida e volta, senha errada e adulteração falham', () => {
  const plain = path.join(dir, 'p.sqlite');
  makeSqlite(plain, 'dado-secreto');
  const enc = path.join(dir, 'p.sqlite.enc');
  encryptFile(plain, enc);
  assert.ok(!fs.readFileSync(enc).includes('dado-secreto'), 'conteúdo não aparece em claro');

  const back = path.join(dir, 'back.sqlite');
  decryptFile(enc, back);
  assert.deepEqual(fs.readFileSync(back), fs.readFileSync(plain));

  process.env.BACKUP_PASSPHRASE = 'outra-senha';
  assert.throws(() => decryptFile(enc, path.join(dir, 'x.sqlite')), /senha|segredo/i);
  delete process.env.BACKUP_PASSPHRASE;

  const tampered = Buffer.from(fs.readFileSync(enc));
  tampered[tampered.length - 20] ^= 0xff;
  fs.writeFileSync(enc + '.bad', tampered);
  assert.throws(() => decryptFile(enc + '.bad', path.join(dir, 'y.sqlite')), /alterado|senha/i);
  assert.ok(!fs.existsSync(path.join(dir, 'y.sqlite')));
});

test('BackupService cria .enc quando BACKUP_ENCRYPT=1 e npm run restore restaura', async () => {
  process.env.BACKUP_ENCRYPT = '1';
  const file = await createBackup(db, 'manual');
  delete process.env.BACKUP_ENCRYPT;
  assert.ok(file.endsWith('.sqlite.enc'));
  assert.ok(!fs.existsSync(file.replace(/\.enc$/, '')), 'arquivo aberto removido');
  assert.equal(listBackups().find(b => b.file === path.basename(file))?.encrypted, true);

  // Restauração real, em outro "diretório de instalação", pelo mesmo script do npm run restore.
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'central-restore-'));
  const dbPath = path.join(target, 'database.sqlite');
  const run = (extraEnv: Record<string, string>) => spawnSync(
    process.execPath, ['--import', 'tsx', 'src/restoreBackup.ts', file],
    { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, DB_PATH: dbPath, ...extraEnv } }
  );

  const wrong = run({ BACKUP_PASSPHRASE: 'senha-errada' });
  assert.equal(wrong.status, 1, wrong.stdout + wrong.stderr);
  assert.ok(!fs.existsSync(dbPath));

  const good = run({});
  assert.equal(good.status, 0, good.stdout + good.stderr);
  const restored = new Database(dbPath, { readonly: true });
  const users = (restored.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
  restored.close();
  assert.equal(users, 1, 'banco restaurado contém o ADMIN criado no teste de setup');
});

test('hash do script inline é igual com fim de linha CRLF (Windows) e LF', () => {
  const lf = path.join(dir, 'lf.html');
  const crlf = path.join(dir, 'crlf.html');
  fs.writeFileSync(lf, '<html><script>\nvar a=1;\nvar b=2;\n</script></html>');
  fs.writeFileSync(crlf, '<html><script>\r\nvar a=1;\r\nvar b=2;\r\n</script></html>');
  assert.deepEqual(inlineScriptHashes(crlf), inlineScriptHashes(lf));
});
