import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { useTempEnvironment } from './helpers.js';

const dataDir = useTempEnvironment();
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
process.env.LICENSE_PUBLIC_KEY = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const HW = 'ef'.repeat(16);
process.env.LICENSE_HW_OVERRIDE = HW;


const { initDatabase, db } = await import('../src/config/database.js');
const License = await import('../src/license/LicenseService.js');
const { openDb } = await import('../license-server/src/db.js');
const { createApp } = await import('../license-server/src/app.js');

initDatabase();

const serverDb = openDb(':memory:');
const http = createApp({ db: serverDb, privateKey, adminApiKey: 'k'.repeat(40) }).listen(0, '127.0.0.1');
await new Promise(r => http.once('listening', r));
const URL_BASE = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
after(() => http.close());

const DAY = 24 * 60 * 60 * 1000;
const identity = { name: 'Bar do Zé', cnpj: '11.222.333/0001-81', email: 'dono@bar.com.br', consent: true };

test('sem internet: segue na avaliação local e guarda os dados para registrar depois', async () => {
  // Porta fechada = sem internet.
  const out = await License.registerTrial({ ...identity, serverUrl: 'http://127.0.0.1:1' });
  assert.equal(out.registered, false);
  assert.equal(out.status.state, 'TRIAL');
  assert.equal(out.status.trialPending, true);
  assert.equal(out.status.blocked, false);
});

test('com internet: o worker registra o trial no servidor e a licença dele passa a valer', async () => {
  // O dado pendente aponta para a porta fechada; troca para o servidor de teste, como se a internet voltasse.
  const pendingFile = path.join(dataDir, '.license-trial-pending');
  const pending = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
  fs.writeFileSync(pendingFile, JSON.stringify({ ...pending, serverUrl: URL_BASE }));

  await License.retryPendingTrial();
  const st = License.getStatus();
  assert.equal(st.trialRegistered, true);
  assert.equal(st.trialPending, false);
  assert.equal(st.state, 'TRIAL');
  assert.equal(st.daysLeft, 7);
  assert.equal(fs.existsSync(pendingFile), false);
  assert.equal(License.hasFeature('fiscal'), true, 'avaliação libera todos os módulos');
});

test('avaliação do servidor vence em 7 dias, sem carência, e bloqueia', () => {
  const day8 = License.getStatus(Date.now() + 7 * DAY + 60_000);
  assert.equal(day8.state, 'TRIAL_EXPIRED');
  assert.equal(day8.blocked, true);
  assert.equal(License.getStatus(Date.now() + 6 * DAY).blocked, false);
});

test('reinstalar (banco novo) não dá avaliação nova: o servidor devolve a mesma, já vencida', async () => {
  // Simula banco apagado: volta ao estado de instalação nova.
  db.prepare("UPDATE license_state SET token = NULL, client_id = NULL, server_url = NULL, trial_started_at = ? WHERE id = 1").run(new Date().toISOString());
  assert.equal(License.getStatus().state, 'TRIAL');

  // O trial no servidor já passou de 7 dias.
  serverDb.prepare('UPDATE trials SET expires_at = ?').run(new Date(Date.now() - DAY).toISOString());
  const out = await License.registerTrial({ ...identity, serverUrl: URL_BASE });
  assert.equal(out.registered, true);
  assert.equal(out.status.state, 'TRIAL_EXPIRED');
  assert.equal(out.status.blocked, true);
});

test('servidor diz que já foi usado (outro e-mail): a central respeita e encerra a avaliação local', async () => {
  db.prepare("UPDATE license_state SET token = NULL, client_id = NULL, trial_started_at = ? WHERE id = 1").run(new Date().toISOString());
  assert.equal(License.getStatus().state, 'TRIAL');
  await assert.rejects(
    License.registerTrial({ ...identity, email: 'outro@bar.com.br', serverUrl: URL_BASE }),
    (e: any) => e.statusCode === 409 && e.code === 'TRIAL_USED'
  );
  const st = License.getStatus();
  assert.equal(st.state, 'TRIAL_EXPIRED');
  assert.equal(st.blocked, true);
});

test('uma avaliação não substitui licença de verdade', async () => {
  const c = await fetch(`${URL_BASE}/admin/clients`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': 'k'.repeat(40) },
    body: JSON.stringify({ name: 'Cliente Pago', paid_until: new Date(Date.now() + 20 * DAY).toISOString().slice(0, 10) })
  }).then(r => r.json() as Promise<any>);
  const st = await License.activate(URL_BASE, c.client.id, c.activation_code);
  assert.equal(st.state, 'ACTIVE');
  assert.ok(License.getDeviceSecret(c.client.id));
  await assert.rejects(License.registerTrial({ ...identity, serverUrl: URL_BASE }), /já tem uma licença/);
  // Refresh de licença paga continua funcionando com o segredo.
  assert.equal((await License.refresh()).state, 'ACTIVE');
});
