import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useTempEnvironment } from './helpers.js';

useTempEnvironment();

const { initDatabase, db } = await import('../src/config/database.js');
const { AuthService } = await import('../src/services/AuthService.js');
const { OrderRepository } = await import('../src/repositories/OrderRepository.js');
const { CashierRepository } = await import('../src/repositories/CashierRepository.js');
const { getSchemaVersion, pendingMigrations } = await import('../src/config/migrations.js');

initDatabase();

const admin = (await AuthService.setup('Dono', 'dono', 'senha-forte-1', '127.0.0.1')).user;
const waiter = await AuthService.createUser('Garçom', 'garcom', 'WAITER', 'garcom-1');
const cashier = await AuthService.createUser('Caixa', 'caixa', 'CASHIER', 'caixa-12');

const stock = (id: string) => (db.prepare('SELECT quantity FROM inventory WHERE id = ?').get(id) as { quantity: number }).quantity;
const setStock = (id: string, q: number) => db.prepare('UPDATE inventory SET quantity = ? WHERE id = ?').run(q, id);
const orderCount = () => (db.prepare('SELECT COUNT(*) as c FROM orders').get() as { c: number }).c;

// Do cardápio de demonstração: m1 (X-Burguer) usa 1 pão + 1 carne + 2 cheddar; m2 usa 1 pão.
const PAO = 'inv-pao';
const CARNE = 'inv-carne';

test('migrações aplicadas e repetíveis', () => {
  const version = getSchemaVersion(db);
  assert.ok(version >= 3);
  assert.equal(pendingMigrations(db).length, 0);
  initDatabase();
  assert.equal(getSchemaVersion(db), version);
});

test('reiniciar o servidor não sobrescreve preço alterado pelo cliente', () => {
  db.prepare("UPDATE menu_items SET price = 99.9 WHERE id = 'm1'").run();
  initDatabase();
  assert.equal((db.prepare("SELECT price FROM menu_items WHERE id = 'm1'").get() as { price: number }).price, 99.9);
});

test('pedido baixa o estoque uma vez e registra a movimentação', () => {
  setStock(PAO, 10);
  const { order } = OrderRepository.createOrder({ table_id: 't1', waiter_id: waiter.id }, [{ menu_item_id: 'm1', quantity: 2 }]);
  assert.ok(order);
  assert.equal(stock(PAO), 8);
  const moves = db.prepare("SELECT SUM(delta) as d FROM inventory_movements WHERE inventory_id = ? AND reason = 'SALE'").get(PAO) as { d: number };
  assert.equal(moves.d, -2);
});

test('falha no 2º item não grava pedido nem baixa estoque do 1º', () => {
  setStock(PAO, 10);
  setStock(CARNE, 0);
  const before = orderCount();
  const { order, error } = OrderRepository.createOrder(
    { table_id: 't2', waiter_id: waiter.id },
    [{ menu_item_id: 'm2', quantity: 1 }, { menu_item_id: 'm1', quantity: 1 }]
  );
  assert.equal(order, null);
  assert.match(error!, /Estoque insuficiente/);
  assert.equal(stock(PAO), 10);
  assert.equal(orderCount(), before);
  setStock(CARNE, 50);
});

test('itens que dividem o mesmo insumo são somados na checagem', () => {
  setStock(PAO, 1);
  const { order, error } = OrderRepository.createOrder(
    { table_id: 't3', waiter_id: waiter.id },
    [{ menu_item_id: 'm1', quantity: 1 }, { menu_item_id: 'm2', quantity: 1 }]
  );
  assert.equal(order, null);
  assert.match(error!, /Pão/);
  assert.equal(stock(PAO), 1);
});

test('produto inexistente não vira outro produto', () => {
  const { order, error } = OrderRepository.createOrder({ table_id: 't1', waiter_id: waiter.id }, [{ menu_item_id: 'm999', quantity: 1 }]);
  assert.equal(order, null);
  assert.match(error!, /não encontrado/);
});

test('pedido offline reenviado não duplica', () => {
  setStock(PAO, 10);
  const items = [{ menu_item_id: 'm2', quantity: 1 }];
  const first = OrderRepository.createOrder({ table_id: 't4', waiter_id: waiter.id, offline_sync_id: 'sync-1' }, items);
  const again = OrderRepository.createOrder({ table_id: 't4', waiter_id: waiter.id, offline_sync_id: 'sync-1' }, items);
  assert.equal(first.order!.id, again.order!.id);
  assert.equal(stock(PAO), 9);
});

test('cancelar item devolve o estoque, guarda o motivo e recalcula a conta', () => {
  setStock(PAO, 10);
  const { order } = OrderRepository.createOrder({ table_id: 't5', waiter_id: waiter.id }, [{ menu_item_id: 'm1', quantity: 3 }]);
  const item = order!.items![0]!;
  assert.equal(stock(PAO), 7);

  OrderRepository.updateOrderItemQuantity(item.id, 1, { userId: waiter.id, role: 'WAITER' }, 'cliente desistiu');
  assert.equal(stock(PAO), 9);

  OrderRepository.cancelOrderItem(item.id, { userId: cashier.id, role: 'CASHIER' }, 'erro de lançamento');
  assert.equal(stock(PAO), 10);

  const row = db.prepare('SELECT status, cancel_reason, cancelled_by FROM order_items WHERE id = ?').get(item.id) as any;
  assert.equal(row.status, 'CANCELLED');
  assert.equal(row.cancel_reason, 'erro de lançamento');
  assert.equal(row.cancelled_by, cashier.id);
  assert.equal((db.prepare('SELECT status FROM orders WHERE id = ?').get(order!.id) as any).status, 'CANCELLED');
});

test('garçom não cancela item que a cozinha já começou', () => {
  const { order } = OrderRepository.createOrder({ table_id: 't6', waiter_id: waiter.id }, [{ menu_item_id: 'm4', quantity: 1 }]);
  const item = order!.items![0]!;
  OrderRepository.updateOrderItemStatus(item.id, 'PREPARING');
  assert.throws(() => OrderRepository.cancelOrderItem(item.id, { userId: waiter.id, role: 'WAITER' }), /em preparo/);
  OrderRepository.cancelOrderItem(item.id, { userId: admin.id, role: 'ADMIN' }, 'devolvido');
});

test('item cancelado pela cozinha não entra na conta', () => {
  const { order } = OrderRepository.createOrder(
    { table_id: 't7', waiter_id: waiter.id },
    [{ menu_item_id: 'm4', quantity: 1 }, { menu_item_id: 'm5', quantity: 1 }]
  );
  const [a] = order!.items!;
  OrderRepository.updateOrderItemStatus(a!.id, 'CANCELLED');
  const bill = OrderRepository.getTableBill('t7')!;
  const remaining = order!.items!.filter(i => i.id !== a!.id).reduce((acc, i) => acc + i.total_price, 0);
  assert.equal(bill.total_amount, Number(remaining.toFixed(2)));
});

test('fechar o expediente não baixa o estoque de novo', () => {
  setStock(PAO, 20);
  OrderRepository.createOrder({ table_id: 't8', waiter_id: waiter.id }, [{ menu_item_id: 'm2', quantity: 2 }]);
  const bill = OrderRepository.getTableBill('t8')!;
  CashierRepository.processPayment('t8', [{ method: 'PIX', amount: bill.total_amount }], cashier.id, false);
  const afterSale = stock(PAO);
  assert.equal(afterSale, 18);

  assert.throws(() => CashierRepository.closeDailyExpedient(undefined, cashier.id), /Conte o dinheiro/);
  const expected = CashierRepository.getCashSummary(CashierRepository.getActiveSession()!).expected_cash;
  const result = CashierRepository.closeDailyExpedient(undefined, cashier.id, expected);
  assert.equal(result.cash_check?.cash_difference, 0);
  assert.equal(stock(PAO), afterSale);
  const pao = result.inventory_consumed.find(i => i.id === PAO);
  assert.ok(pao && pao.total_consumed >= 2);
});

test('caixa precisa do PIN de supervisor para cancelar item em preparo', async () => {
  await AuthService.setOwnPin(admin.id, 'senha-forte-1', '4321');
  const { order } = OrderRepository.createOrder({ table_id: 't9', waiter_id: waiter.id }, [{ menu_item_id: 'm4', quantity: 1 }]);
  const item = order!.items![0]!;
  OrderRepository.updateOrderItemStatus(item.id, 'READY');

  assert.throws(() => OrderRepository.cancelOrderItem(item.id, { userId: cashier.id, role: 'CASHIER' }), /PIN do supervisor/);
  await assert.rejects(AuthService.verifySupervisorPin('0000', '127.0.0.1'), /PIN de supervisor inválido/);
  const supervisor = await AuthService.verifySupervisorPin('4321', '127.0.0.1');
  assert.equal(supervisor.id, admin.id);
  OrderRepository.cancelOrderItem(item.id, { userId: cashier.id, role: 'CASHIER', supervisorId: supervisor.id }, 'cliente reclamou');
});

test('conferência do caixa: fundo + dinheiro + suprimento − sangria, em centavos', () => {
  CashierRepository.openSession(cashier.id, 100);
  // 3 itens de R$ 0,10 somados em ponto flutuante dariam 0.30000000000000004
  db.prepare("UPDATE menu_items SET price = 0.1 WHERE id = 'm4'").run();
  OrderRepository.createOrder({ table_id: 't10', waiter_id: waiter.id }, [{ menu_item_id: 'm4', quantity: 3 }]);
  const bill = OrderRepository.getTableBill('t10')!;
  assert.equal(bill.total_amount, 0.3);

  const paid = CashierRepository.processPayment('t10', [{ method: 'CASH', amount: 0.3, amount_paid: 50 }], cashier.id, false);
  assert.equal(paid.change_given, 49.7);

  CashierRepository.addCashMovement('SUPRIMENTO', 20, 'troco extra', cashier.id);
  CashierRepository.addCashMovement('SANGRIA', 70.1, 'depósito no cofre', cashier.id);
  assert.throws(() => CashierRepository.addCashMovement('SANGRIA', 1000, 'maior que a gaveta', cashier.id), /maior que o dinheiro/);

  const summary = CashierRepository.getCashSummary(CashierRepository.getActiveSession()!);
  assert.equal(summary.expected_cash, 50.2); // 100 + 0,30 + 20 − 70,10

  const closed = CashierRepository.closeSession(CashierRepository.getActiveSession()!.id, cashier.id, 48.2, 'faltou troco');
  assert.equal(closed.cash_difference, -2);
});

test('cartão e Pix não geram troco nem aceitam valor recebido maior', () => {
  OrderRepository.createOrder({ table_id: 't1', waiter_id: waiter.id }, [{ menu_item_id: 'm4', quantity: 1 }]);
  const bill = OrderRepository.getTableBill('t1')!;
  const res = CashierRepository.processPayment('t1', [{ method: 'CREDIT_CARD', amount: bill.total_amount, amount_paid: 999 }], cashier.id, false);
  assert.equal(res.change_given, 0);
  assert.equal(res.payments[0]!.amount_paid, bill.total_amount);
});
