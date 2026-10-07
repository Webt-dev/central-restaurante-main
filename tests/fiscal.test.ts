import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { useTempEnvironment } from './helpers.js';

useTempEnvironment();

const { initDatabase, db } = await import('../src/config/database.js');
const { AuthService } = await import('../src/services/AuthService.js');
const { OrderRepository } = await import('../src/repositories/OrderRepository.js');
const { CashierService } = await import('../src/services/CashierService.js');
const Fiscal = await import('../src/fiscal/FiscalService.js');
const { AcbrMonitorProvider, buildIni, parseIni } = await import('../src/fiscal/AcbrMonitorProvider.js');

initDatabase();

const admin = (await AuthService.setup('Dono', 'dono', 'senha-forte-1', '127.0.0.1')).user;
const waiter = await AuthService.createUser('Garçom', 'garcom', 'WAITER', 'garcom-1');

const CONFIG = {
  provider: 'simulacao' as const,
  ambiente: 2 as const,
  serie: 1,
  cnpj: '11.222.333/0001-81',
  ie: '123456789',
  razao_social: 'Restaurante Teste LTDA',
  nome_fantasia: 'Restaurante Teste',
  crt: '1' as const,
  logradouro: 'Rua A',
  numero: '10',
  bairro: 'Centro',
  codigo_municipio: '3550308',
  municipio: 'São Paulo',
  uf: 'SP',
  cep: '01001-000',
  telefone: '11999999999',
  cfop_padrao: '5102',
  csosn_padrao: '102',
  cst_pis_cofins_padrao: '49'
};

async function sell(tableId: string, menuItemId = 'm4', cpf?: string) {
  OrderRepository.createOrder({ table_id: tableId, waiter_id: waiter.id }, [{ menu_item_id: menuItemId, quantity: 2 }]);
  const bill = OrderRepository.getTableBill(tableId)!;
  const tip = Number((bill.total_amount * 0.1).toFixed(2));
  const result = CashierService.processTablePayment(tableId, admin.id, [{ method: 'PIX', amount: bill.total_amount + tip }], true, cpf);
  // A emissão roda em segundo plano; aguardamos o processamento terminar.
  if (result.fiscal) await Fiscal.processar(result.fiscal.id);
  return { bill, fiscal: result.fiscal ? Fiscal.findById(result.fiscal.id) : null };
}

test('módulo vem desligado e o caixa funciona sem emitir nota', async () => {
  assert.equal(Fiscal.isEnabled(), false);
  const { fiscal } = await sell('t1');
  assert.equal(fiscal, null);
});

test('não liga sem configuração completa e NCM em todos os produtos', async () => {
  await assert.rejects(Fiscal.ativar(true), /Ainda falta/);
  Fiscal.updateConfig(CONFIG);
  assert.ok(Fiscal.validarConfig().some(p => /sem NCM/.test(p)));
  db.prepare("UPDATE menu_items SET ncm = '21069090'").run();
  assert.deepEqual(Fiscal.validarConfig(), []);
});

test('simulação é recusada em produção', () => {
  assert.ok(Fiscal.validarConfig({ ...Fiscal.getConfig(), ambiente: 1 }).some(p => /homologação/.test(p)));
});

test('liga após o teste com a SEFAZ e emite no fechamento da conta', async () => {
  const r = await Fiscal.ativar(true);
  assert.equal(r.enabled, true);

  const { bill, fiscal } = await sell('t2', 'm4', '529.982.247-25');
  assert.equal(fiscal?.status, 'AUTORIZADO');
  assert.equal(fiscal?.chave?.length, 44);
  // Taxa de serviço fica fora da nota: valor da NFC-e = consumo.
  assert.equal(fiscal?.valor_total, bill.total_amount);
  const payload = JSON.parse((db.prepare('SELECT payload_json FROM fiscal_documents WHERE id = ?').get(fiscal!.id) as any).payload_json);
  assert.equal(payload.pagamentos.reduce((a: number, p: any) => a + p.valor, 0), bill.total_amount);
  assert.equal(payload.cpf_consumidor, '52998224725');
});

test('CPF inválido é recusado antes de fechar a conta', async () => {
  OrderRepository.createOrder({ table_id: 't3', waiter_id: waiter.id }, [{ menu_item_id: 'm4', quantity: 1 }]);
  const bill = OrderRepository.getTableBill('t3')!;
  assert.throws(() => CashierService.processTablePayment('t3', admin.id, [{ method: 'PIX', amount: bill.total_amount }], false, '111.111.111-11'), /CPF/);
  assert.equal(OrderRepository.getTableBill('t3')!.orders.length, 1);
});

test('SEFAZ fora: nota sai em contingência e é transmitida depois', async () => {
  process.env.SIMULACAO_OFFLINE = '1';
  const { fiscal } = await sell('t4');
  assert.equal(fiscal?.status, 'CONTINGENCIA');
  assert.equal(fiscal?.tp_emis, 9);
  await assert.rejects(Fiscal.ativar(false), /não autorizada/);

  delete process.env.SIMULACAO_OFFLINE;
  db.prepare('UPDATE fiscal_documents SET proxima_tentativa = NULL').run();
  await Fiscal.processarFila();
  const after = Fiscal.findById(fiscal!.id)!;
  assert.equal(after.status, 'AUTORIZADO');
  assert.equal(after.chave, fiscal!.chave);
});

test('produto sem NCM fica com erro até corrigir e reprocessar', async () => {
  db.prepare("UPDATE menu_items SET ncm = NULL WHERE id = 'm5'").run();
  const { fiscal } = await sell('t5', 'm5');
  assert.equal(fiscal?.status, 'ERRO');
  assert.match(fiscal!.motivo!, /sem NCM/);
  await assert.rejects(Fiscal.reprocessar(fiscal!.id), /sem NCM/);
  db.prepare("UPDATE menu_items SET ncm = '22029900' WHERE id = 'm5'").run();
  assert.equal((await Fiscal.reprocessar(fiscal!.id))?.status, 'AUTORIZADO');
});

test('cancelamento exige justificativa de 15 caracteres e respeita o prazo', async () => {
  const { fiscal } = await sell('t6');
  await assert.rejects(Fiscal.cancelar(fiscal!.id, 'curta'), /15 a 255/);
  assert.equal((await Fiscal.cancelar(fiscal!.id, 'Cliente desistiu da compra'))?.status, 'CANCELADO');

  const { fiscal: old } = await sell('t7');
  db.prepare("UPDATE fiscal_documents SET autorizado_em = datetime('now', 'localtime', '-31 minutes') WHERE id = ?").run(old!.id);
  await assert.rejects(Fiscal.cancelar(old!.id, 'Cliente desistiu da compra'), /prazo/);
});

test('numeração é sequencial por série', () => {
  const nums = (db.prepare('SELECT numero FROM fiscal_documents ORDER BY numero').all() as { numero: number }[]).map(r => r.numero);
  assert.deepEqual(nums, nums.map((_, i) => i + 1));
});

test('INI do ACBr tem os grupos da NFC-e e não deixa aspas quebrarem o comando', () => {
  const ini = buildIni({
    ambiente: 2, serie: 1, numero: 7, emissao: '2026-10-07T12:00:00-03:00', tp_emis: 1,
    emitente: { cnpj: '11222333000181', ie: '1', razao_social: 'Bar "do Zé"', nome_fantasia: 'Zé', crt: '1', logradouro: 'R', numero: '1', bairro: 'B', codigo_municipio: '3550308', municipio: 'SP', uf: 'SP', cep: '01001000', telefone: '' },
    itens: [{ codigo: 'm1', descricao: 'X "Burguer"', ncm: '21069090', cfop: '5102', unidade: 'UN', quantidade: 2, valor_unitario: 10, valor_total: 20, origem: '0', csosn: '102', cst_pis_cofins: '49' }],
    pagamentos: [{ tpag: '17', valor: 20 }],
    valor_total: 20
  });
  assert.ok(!ini.includes('"'));
  const map = parseIni(ini);
  assert.equal(map.get('identificacao.mod'), '65');
  assert.equal(map.get('produto001.ncm'), '21069090');
  assert.equal(map.get('icms001.csosn'), '102');
  assert.equal(map.get('total.vnf'), '20.00');
  assert.equal(map.get('pag001.tpag'), '17');
});

test('protocolo TCP do ACBrMonitor: saudação, comando e resposta com ETX', async () => {
  const received: string[] = [];
  const server = net.createServer(sock => {
    sock.write('Esperando por comandos.\x03');
    let buf = '';
    sock.on('data', d => {
      buf += d.toString('latin1');
      if (!buf.endsWith('\r\n.\r\n')) return;
      received.push(buf);
      if (buf.startsWith('NFE.StatusServico')) {
        sock.write('OK: [Status]\r\nCStat=107\r\nXMotivo=Servico em Operacao\r\n\x03');
      } else {
        sock.write('OK: [Retorno]\r\nCStat=100\r\nXMotivo=Autorizado o uso da NF-e\r\n[NFe1]\r\nchDFe=35261011222333000181650010000000071000000070\r\nnProt=135260000000001\r\n\x03');
      }
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  const acbr = new AcbrMonitorProvider({ host: '127.0.0.1', port });

  const status = await acbr.statusServico(2, 'SP');
  assert.equal(status.online, true);

  const r = await acbr.emitir({
    ambiente: 2, serie: 1, numero: 7, emissao: '2026-10-07T12:00:00-03:00', tp_emis: 1,
    emitente: { cnpj: '11222333000181', ie: '1', razao_social: 'R', nome_fantasia: 'R', crt: '1', logradouro: 'R', numero: '1', bairro: 'B', codigo_municipio: '3550308', municipio: 'SP', uf: 'SP', cep: '01001000', telefone: '' },
    itens: [{ codigo: 'm1', descricao: 'X', ncm: '21069090', cfop: '5102', unidade: 'UN', quantidade: 1, valor_unitario: 10, valor_total: 10, origem: '0', csosn: '102', cst_pis_cofins: '49' }],
    pagamentos: [{ tpag: '01', valor: 10 }],
    valor_total: 10
  });
  assert.equal(r.status, 'AUTORIZADO');
  assert.equal(r.status === 'AUTORIZADO' && r.protocolo, '135260000000001');
  assert.ok(received[1]!.startsWith('NFE.CriarEnviarNFe("[infNFe]'));
  server.close();

  // Motor desligado = indisponível (para o serviço cair em contingência), não "rejeitado".
  const down = await new AcbrMonitorProvider({ host: '127.0.0.1', port }).statusServico(2, 'SP');
  assert.equal(down.online, false);
  assert.match(down.motivo, /ACBrMonitor/);
});
