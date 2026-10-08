import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { useTempEnvironment } from './helpers.js';

useTempEnvironment();

// Par de chaves só deste teste: a central confia na pública, o servidor assina com a privada.
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
process.env.LICENSE_PUBLIC_KEY = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const HW = 'ab'.repeat(16);
process.env.LICENSE_HW_OVERRIDE = HW;

const { initDatabase, db } = await import('../src/config/database.js');
const License = await import('../src/license/LicenseService.js');
const { requireLicense, requireLicenseToOccupy } = await import('../src/middlewares/licenseMiddleware.js');
const { openDb } = await import('../license-server/src/db.js');
const { createApp } = await import('../license-server/src/app.js');
const { addDays, todayBrt, issueToken, getClient, cycleStart } = await import('../license-server/src/licenses.js');
const { verifyMercadoPagoSignature } = await import('../license-server/src/mercadopago.js');

initDatabase();

const ADMIN_KEY = 'k'.repeat(40);
const MP_SECRET = 'segredo-do-webhook-mp-0123456789';

// API do Mercado Pago falsa: pagamentos, faturas de assinatura e assinaturas em memória.
const mp = {
  payments: new Map<string, any>(),
  invoices: new Map<string, any>(),
  preapprovals: new Map<string, any>(),
  created: [] as any[]
};
const fakeMpApi = {
  getPayment: async (id: string) => { const p = mp.payments.get(id); if (!p) throw new Error('404'); return p; },
  getAuthorizedPayment: async (id: string) => { const p = mp.invoices.get(id); if (!p) throw new Error('404'); return p; },
  getPreapproval: async (id: string) => { const p = mp.preapprovals.get(id); if (!p) throw new Error('404'); return p; },
  createPreapproval: async (b: any) => {
    mp.created.push(b);
    const pre = { id: `pre${mp.created.length}abc`, external_reference: b.external_reference, init_point: 'https://www.mercadopago.com.br/subscriptions/checkout?preapproval_id=x' };
    mp.preapprovals.set(pre.id, pre);
    return pre;
  }
};

const serverDb = openDb(':memory:');
const http = createApp({
  db: serverDb,
  privateKey,
  adminApiKey: ADMIN_KEY,
  mercadoPago: { api: fakeMpApi, webhookSecret: MP_SECRET, backUrl: 'https://exemplo.com.br/obrigado' }
}).listen(0, '127.0.0.1');
await new Promise(r => http.once('listening', r));
const URL_BASE = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
after(() => http.close());

const DAY = 24 * 60 * 60 * 1000;
const adminCall = (path: string, method = 'GET', body?: unknown) =>
  fetch(URL_BASE + path, { method, headers: { 'Content-Type': 'application/json', 'x-api-key': ADMIN_KEY }, body: body ? JSON.stringify(body) : undefined })
    .then(async r => ({ status: r.status, data: await r.json() as any }));
/** Envia um aviso como o Mercado Pago: id na query e no corpo, assinado com x-signature. */
let requestSeq = 0;
const webhook = (type: string, id: string, secret = MP_SECRET) => {
  const requestId = `req-${++requestSeq}`;
  const ts = String(Math.floor(Date.now() / 1000));
  const manifest = `id:${/[a-z]/i.test(id) ? id.toLowerCase() : id};request-id:${requestId};ts:${ts};`;
  const v1 = createHmac('sha256', secret).update(manifest).digest('hex');
  return fetch(`${URL_BASE}/v1/webhooks/mercadopago?data.id=${id}&type=${type}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-signature': `ts=${ts},v1=${v1}`, 'x-request-id': requestId },
    body: JSON.stringify({ type, action: `${type}.updated`, data: { id } })
  }).then(async r => ({ status: r.status, data: await r.json() as any }));
};

function fakeRes() {
  const res: any = { statusCode: 200, body: null };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  return res;
}

const paidUntilDate = addDays(todayBrt(), 10);
let clientId = '';
let activationCode = '';

test('instalação nova: 7 dias de avaliação, depois bloqueia', () => {
  const st = License.getStatus();
  assert.equal(st.state, 'TRIAL');
  assert.equal(st.blocked, false);
  assert.equal(License.getStatus(Date.now() + 8 * DAY).state, 'TRIAL_EXPIRED');
  assert.equal(License.getStatus(Date.now() + 8 * DAY).blocked, true);
});

test('servidor cria o cliente e entrega o código de ativação uma única vez', async () => {
  const unauthorized = await fetch(`${URL_BASE}/admin/clients`).then(r => r.status);
  assert.equal(unauthorized, 401);
  const r = await adminCall('/admin/clients', 'POST', { name: 'Bar do Zé', plan: 'padrao', features: [], paid_until: paidUntilDate });
  assert.equal(r.status, 201);
  clientId = r.data.client.id;
  activationCode = r.data.activation_code;
  assert.match(activationCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
});

test('ativação com código errado é recusada', async () => {
  await assert.rejects(License.activate(URL_BASE, clientId, 'AAAA-BBBB-CCCC'), /incorreto/);
});

test('ativa a central e a licença fica em dia', async () => {
  const st = await License.activate(URL_BASE, clientId, activationCode.toLowerCase());
  assert.equal(st.state, 'ACTIVE');
  assert.equal(st.clientName, 'Bar do Zé');
  assert.equal(st.paidUntil, `${paidUntilDate}T23:59:59-03:00`);
  assert.equal(st.validUntil, `${addDays(paidUntilDate, 7)}T23:59:59-03:00`);
});

test('régua: aviso 3 dias antes, carência de 7 dias e bloqueio no 8º', () => {
  const paid = Date.parse(`${paidUntilDate}T23:59:59-03:00`);
  assert.equal(License.getStatus(paid - 2 * DAY).state, 'DUE_SOON');

  const d1 = License.getStatus(paid + 60_000);
  assert.equal(d1.state, 'GRACE');
  assert.equal(d1.daysOverdue, 1);
  assert.equal(d1.daysUntilBlock, 7);
  assert.equal(d1.blocked, false);

  const d7 = License.getStatus(paid + 6 * DAY + 60_000);
  assert.equal(d7.state, 'GRACE');
  assert.equal(d7.daysOverdue, 7);

  const d8 = License.getStatus(paid + 7 * DAY + 60_000);
  assert.equal(d8.state, 'BLOCKED');
  assert.equal(d8.blocked, true);
});

test('bloqueado: trava abrir mesa e lançar pedido, mas não liberar mesa', async () => {
  // Força uma licença já vencida há 8 dias, emitida pelo servidor de teste.
  serverDb.prepare('UPDATE clients SET base_paid_until = ? WHERE id = ?').run(addDays(todayBrt(), -9), clientId);
  await License.refresh();
  assert.equal(License.getStatus().state, 'BLOCKED');

  const res = fakeRes();
  let passed = false;
  requireLicense({} as any, res, () => { passed = true; });
  assert.equal(passed, false);
  assert.equal(res.statusCode, 402);
  assert.equal(res.body.code, 'LICENSE_BLOCKED');

  let freed = false;
  requireLicenseToOccupy({ body: { status: 'FREE' } } as any, fakeRes(), () => { freed = true; });
  assert.equal(freed, true);
});

test('aviso do Mercado Pago com assinatura errada é recusado', async () => {
  mp.payments.set('9001', { id: 9001, status: 'approved', transaction_amount: 150, external_reference: clientId, date_approved: new Date().toISOString() });
  assert.equal((await webhook('payment', '9001', 'segredo-errado-0000000000000000')).status, 401);
  assert.equal(verifyMercadoPagoSignature({ xSignature: 'ts=1,v1=abc', xRequestId: 'x', dataId: '1', secret: MP_SECRET }), false);
});

test('pagamento aprovado no Mercado Pago libera na hora (idempotente)', async () => {
  const first = await webhook('payment', '9001');
  assert.equal(first.status, 200);
  assert.equal(first.data.created, true);
  const again = await webhook('payment', '9001');
  assert.equal(again.data.created, false);

  // Cliente estava bloqueado: pagou hoje, ciclo novo de 1 mês a partir de hoje.
  const st = await License.refresh();
  assert.equal(st.state, 'ACTIVE');
  assert.equal(License.getStatus().blocked, false);
});

test('pagamento pendente ou recusado não libera nada', async () => {
  mp.payments.set('9002', { id: 9002, status: 'pending', transaction_amount: 150, external_reference: clientId });
  assert.equal((await webhook('payment', '9002')).data.ignored, true);
});

test('fatura de assinatura sem referência externa: cliente achado pela assinatura', async () => {
  mp.preapprovals.set('2c938084abc', { id: '2c938084abc', external_reference: clientId });
  mp.payments.set('9003', { id: 9003, status: 'approved', transaction_amount: 150, external_reference: null, date_approved: new Date().toISOString() });
  mp.invoices.set('7001', { id: 7001, preapproval_id: '2c938084abc', payment: { id: 9003, status: 'approved' } });
  const r = await webhook('subscription_authorized_payment', '7001');
  assert.equal(r.data.created, true);
});

test('estorno ou chargeback faz o vencimento recuar', async () => {
  for (const id of ['9001', '9003']) {
    mp.payments.set(id, { ...mp.payments.get(id), status: 'charged_back' });
    await webhook('payment', id);
  }
  assert.equal((await License.refresh()).state, 'BLOCKED');
});

test('ciclo: pagou em dia mantém o vencimento; pagou depois de bloqueado começa ciclo novo', () => {
  assert.equal(cycleStart('2026-10-10', '2026-10-08'), '2026-10-10');
  assert.equal(cycleStart('2026-10-10', '2026-10-15'), '2026-10-10');
  assert.equal(cycleStart('2026-10-10', '2026-10-20'), '2026-10-20');
});

test('cria a assinatura mensal no Mercado Pago e devolve o link para o cliente', async () => {
  const r = await adminCall(`/admin/clients/${clientId}/subscription`, 'POST', { payer_email: 'dono@bardoze.com.br' });
  assert.equal(r.status, 201);
  assert.match(r.data.link, /^https:\/\/www\.mercadopago\.com\.br\//);
  assert.equal(mp.created[0].external_reference, clientId);
  assert.equal(mp.created[0].amount, 150);
});

test('relógio atrasado de propósito bloqueia', () => {
  License.recordSeenTime(Date.now() + 2 * DAY);
  const st = License.getStatus();
  assert.equal(st.state, 'CLOCK');
  assert.equal(st.blocked, true);
  License.recordSeenTime(Date.now(), true);
  assert.notEqual(License.getStatus().state, 'CLOCK');
});

test('licença de outra máquina ou adulterada é recusada', () => {
  const client = getClient(serverDb, clientId)!;
  const otherMachine = issueToken(serverDb, privateKey, client, 'cd'.repeat(16));
  assert.throws(() => License.installToken(otherMachine), /outro computador/);

  const mine = issueToken(serverDb, privateKey, client, HW);
  const [body, sig] = mine.split('.');
  const forged = JSON.parse(Buffer.from(body!, 'base64url').toString());
  forged.validUntil = '2099-12-31T23:59:59-03:00';
  const tampered = `${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${sig}`;
  assert.throws(() => License.installToken(tampered), /assinatura/);
});

test('limite de computadores do plano', async () => {
  const r = await fetch(`${URL_BASE}/v1/activate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, activationCode, hw: 'ef'.repeat(16) })
  });
  assert.equal(r.status, 409);
});

test('pagamento manual pelo admin e módulo fiscal liberado pelo plano', async () => {
  const pay = await adminCall(`/admin/clients/${clientId}/payments`, 'POST', { amount: 150, months: 1, note: 'transferência' });
  assert.equal(pay.status, 201);
  assert.equal((await License.refresh()).state, 'ACTIVE');
  assert.equal(License.hasFeature('fiscal'), false);

  await adminCall(`/admin/clients/${clientId}`, 'PATCH', { features: ['fiscal'] });
  await License.refresh();
  assert.equal(License.hasFeature('fiscal'), true);
});

test('renovação pelo celular: rota de leitura aceita CORS e exige máquina ativada', async () => {
  // Sem o segredo do dispositivo (entregue na ativação) a licença não sai.
  const denied = await fetch(`${URL_BASE}/v1/licenses/${clientId}?hw=${HW}`);
  assert.equal(denied.status, 401);
  const secret = License.getDeviceSecret(clientId);
  assert.ok(secret, 'a central guardou o segredo recebido na ativação');
  const ok = await fetch(`${URL_BASE}/v1/licenses/${clientId}?hw=${HW}`, { headers: { 'x-device-secret': secret } });
  assert.equal(ok.headers.get('access-control-allow-origin'), '*');
  const { token } = await ok.json() as { token: string };
  assert.equal(License.installToken(token).state, 'ACTIVE');

  const unknown = await fetch(`${URL_BASE}/v1/licenses/${clientId}?hw=${'12'.repeat(16)}`);
  assert.equal(unknown.status, 404);
  assert.ok(db);
});
