import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';

const { openDb } = await import('../license-server/src/db.js');
const { createApp } = await import('../license-server/src/app.js');
const { createFocusNfseProvider, processInvoices } = await import('../license-server/src/nfse.js');
type ResultadoNfse = import('../license-server/src/nfse.js').ResultadoNfse;

// ------------------------------------------------- formato da chamada à Focus

test('Focus NFe: autenticação Basic com o token, rota /v2/nfsen?ref= e campos da DPS', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fakeFetch = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    if (init.method === 'POST') return new Response(JSON.stringify({ status: 'processando_autorizacao', ref: 'x' }), { status: 202 });
    return new Response(JSON.stringify({ status: 'autorizado', numero: '15', url_danfse: 'https://x/danfse.pdf' }), { status: 200 });
  }) as typeof fetch;

  const focus = createFocusNfseProvider('meu-token', 'homologacao', fakeFetch);
  const cfg = {
    provider: focus, cnpjPrestador: '11222333000181', codigoMunicipio: '3550308', codigoTributacaoNacional: '010501',
    opcaoSimplesNacional: 3, tributacaoIss: 1, serieDps: 1, descricao: 'Mensalidade'
  };
  const r = await focus.emitir({ ref: 'mensalidade-1', numeroDps: 7, dataEmissao: '2026-10-07T10:00:00-0300', dataCompetencia: '2026-10-07', valor: 150, tomadorCnpj: '99888777000166', cfg });
  assert.equal(r.status, 'processando');

  const post = calls[0]!;
  assert.equal(post.url, 'https://homologacao.focusnfe.com.br/v2/nfsen?ref=mensalidade-1');
  assert.equal((post.init.headers as any).Authorization, `Basic ${Buffer.from('meu-token:').toString('base64')}`);
  const body = JSON.parse(String(post.init.body));
  assert.equal(body.cnpj_prestador, '11222333000181');
  assert.equal(body.cnpj_tomador, '99888777000166');
  assert.equal(body.numero_dps, 7);
  assert.equal(body.codigo_municipio_emissora, 3550308);
  assert.equal(body.codigo_tributacao_nacional_iss, '010501');
  assert.equal(body.valor_servico, 150);

  const c = await focus.consultar('mensalidade-1');
  assert.deepEqual(c, { status: 'autorizada', numero: '15', url: undefined, urlDanfse: 'https://x/danfse.pdf' });
});

// --------------------------------------------- fluxo: pagamento → nota fiscal

const { privateKey } = generateKeyPairSync('ed25519');
const ADMIN_KEY = 'k'.repeat(40);
const MP_SECRET = 'segredo-do-webhook-mp-0123456789';
const payments = new Map<string, any>();

// Provedor de NFS-e falso: decide a resposta por referência.
const emitted: string[] = [];
let nextEmit: ResultadoNfse = { status: 'processando' };
const fakeNfse = {
  emitir: async (d: { ref: string }) => { emitted.push(d.ref); return nextEmit; },
  consultar: async () => ({ status: 'autorizada', numero: '101', urlDanfse: 'https://x/101.pdf' }) as ResultadoNfse
};
const nfseCfg = {
  provider: fakeNfse, cnpjPrestador: '11222333000181', codigoMunicipio: '3550308', codigoTributacaoNacional: '010501',
  opcaoSimplesNacional: 3, tributacaoIss: 1, serieDps: 1, descricao: 'Mensalidade'
};

const db = openDb(':memory:');
const http = createApp({
  db,
  privateKey,
  adminApiKey: ADMIN_KEY,
  mercadoPago: {
    api: {
      getPayment: async (id: string) => payments.get(id),
      getAuthorizedPayment: async () => { throw new Error('não usado'); },
      getPreapproval: async () => { throw new Error('não usado'); },
      createPreapproval: async () => { throw new Error('não usado'); }
    },
    webhookSecret: MP_SECRET,
    backUrl: 'https://exemplo.com.br'
  },
  nfse: nfseCfg
}).listen(0, '127.0.0.1');
await new Promise(r => http.once('listening', r));
const BASE = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
after(() => http.close());

let seq = 0;
function webhook(id: string) {
  const requestId = `r${++seq}`;
  const ts = String(Math.floor(Date.now() / 1000));
  const v1 = createHmac('sha256', MP_SECRET).update(`id:${id};request-id:${requestId};ts:${ts};`).digest('hex');
  return fetch(`${BASE}/v1/webhooks/mercadopago?data.id=${id}&type=payment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-signature': `ts=${ts},v1=${v1}`, 'x-request-id': requestId },
    body: JSON.stringify({ type: 'payment', data: { id } })
  }).then(r => r.json() as Promise<any>);
}
const admin = (path: string, method = 'GET', body?: unknown) =>
  fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', 'x-api-key': ADMIN_KEY }, body: body ? JSON.stringify(body) : undefined })
    .then(r => r.json() as Promise<any>);
const invoices = () => db.prepare('SELECT * FROM invoices ORDER BY id').all() as any[];
const wait = () => new Promise(r => setTimeout(r, 50));

let clientId = '';

test('pagamento aprovado gera a NFS-e da mensalidade, uma única vez', async () => {
  clientId = (await admin('/admin/clients', 'POST', { name: 'Bar do Zé', document: '99.888.777/0001-66' })).client.id;
  payments.set('5001', { id: 5001, status: 'approved', transaction_amount: 150, external_reference: clientId, date_approved: new Date().toISOString() });

  await webhook('5001');
  await webhook('5001');
  await wait();
  assert.equal(invoices().length, 1);
  assert.equal(invoices()[0].status, 'PROCESSANDO');
  assert.equal(emitted.length, 1);

  await processInvoices(db, nfseCfg);
  const inv = invoices()[0];
  assert.equal(inv.status, 'AUTORIZADA');
  assert.equal(inv.numero, '101');
  assert.equal(inv.url_danfse, 'https://x/101.pdf');
});

test('pagamento de cortesia (valor zero) não gera nota', async () => {
  await admin(`/admin/clients/${clientId}/payments`, 'POST', { amount: 0, months: 1, note: 'cortesia' });
  await wait();
  assert.equal(invoices().length, 1);
});

test('nota com erro pode ser reenviada com nova referência e novo número', async () => {
  nextEmit = { status: 'erro', mensagem: 'E0001 código de tributação inválido' };
  await admin(`/admin/clients/${clientId}/payments`, 'POST', { amount: 150, months: 1, note: 'transferência' });
  await wait();
  const failed = invoices()[1];
  assert.equal(failed.status, 'ERRO');
  assert.match(failed.erro, /tributação/);

  nextEmit = { status: 'processando' };
  const retried = await admin(`/admin/invoices/${failed.id}/retry`, 'POST');
  assert.notEqual(retried.ref, failed.ref);
  assert.equal(retried.numero_dps, failed.numero_dps + 1);
  assert.equal(retried.status, 'PROCESSANDO');
  assert.equal((await admin('/admin/invoices?status=PROCESSANDO')).length, 1);
});

test('estorno de pagamento com nota autorizada marca a nota para cancelar', async () => {
  payments.set('5001', { ...payments.get('5001'), status: 'refunded' });
  await webhook('5001');
  assert.equal(invoices()[0].status, 'CANCELAR');
});
