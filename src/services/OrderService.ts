import { OrderRepository, OrderActor } from '../repositories/OrderRepository.js';
import { TableRepository } from '../repositories/TableRepository.js';
import { Order, OrderItem, TableBillSummary } from '../models/types.js';
import { notifyOrderCreated, notifyTableStatusChanged } from '../sockets/socketManager.js';

export class OrderService {
  static createOrder(
    waiterId: string,
    tableId: string,
    items: { menu_item_id: string; quantity: number; notes?: string }[],
    notes?: string,
    offline_sync_id?: string
  ): Order {
    const result = OrderRepository.createOrder({ table_id: tableId, waiter_id: waiterId, notes, offline_sync_id }, items);

    if (result.error || !result.order) {
      throw new Error(result.error || 'Erro ao criar pedido.');
    }

    const order = result.order;

    notifyOrderCreated(order);

    const updatedTable = TableRepository.findById(tableId);
    if (updatedTable) {
      notifyTableStatusChanged(updatedTable);
    }

    return order;
  }

  static syncOfflineBatch(
    waiterId: string,
    batchOrders: {
      table_id: string;
      offline_sync_id: string;
      items: { menu_item_id: string; quantity: number; notes?: string }[];
      notes?: string;
    }[]
  ): { syncedCount: number; errors: { offline_sync_id: string; error: string }[] } {
    let syncedCount = 0;
    const errors: { offline_sync_id: string; error: string }[] = [];

    for (const bOrder of batchOrders) {
      try {
        this.createOrder(waiterId, bOrder.table_id, bOrder.items, bOrder.notes, bOrder.offline_sync_id);
        syncedCount++;
      } catch (err: any) {
        errors.push({
          offline_sync_id: bOrder.offline_sync_id,
          error: err.message || 'Falha ao sincronizar pedido.'
        });
      }
    }

    return { syncedCount, errors };
  }

  static cancelItem(itemId: string, actor: OrderActor, reason?: string): { table_id: string; before: OrderItem } {
    const res = OrderRepository.cancelOrderItem(itemId, actor, reason);
    const table = TableRepository.findById(res.table_id);
    if (table) notifyTableStatusChanged(table);
    return res;
  }

  static updateItemQuantity(itemId: string, quantity: number, actor: OrderActor, reason?: string): { table_id: string; before: OrderItem } {
    const res = OrderRepository.updateOrderItemQuantity(itemId, quantity, actor, reason);
    const table = TableRepository.findById(res.table_id);
    if (table) notifyTableStatusChanged(table);
    return res;
  }

  static getTableBill(tableId: string): TableBillSummary {
    const bill = OrderRepository.getTableBill(tableId);
    if (!bill) {
      throw new Error('Mesa não encontrada.');
    }
    return bill;
  }

  static getOrderById(id: string): Order {
    const order = OrderRepository.findById(id);
    if (!order) {
      throw new Error('Pedido não encontrado.');
    }
    return order;
  }
}
