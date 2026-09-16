import { OrderRepository } from '../repositories/OrderRepository.js';
import { TableRepository } from '../repositories/TableRepository.js';
import { Order, TableBillSummary } from '../models/types.js';
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

  static deleteItemFromOrder(itemId: string): { success: boolean } {
    const res = OrderRepository.deleteOrderItem(itemId);
    if (!res.success) {
      throw new Error('Item não encontrado para exclusão.');
    }

    if (res.table_id) {
      const table = TableRepository.findById(res.table_id);
      if (table) notifyTableStatusChanged(table);
    }

    return { success: true };
  }

  static updateItemQuantity(itemId: string, quantity: number): { success: boolean } {
    const res = OrderRepository.updateOrderItemQuantity(itemId, quantity);
    if (!res.success) {
      throw new Error('Item não encontrado para atualização de quantidade.');
    }

    if (res.table_id) {
      const table = TableRepository.findById(res.table_id);
      if (table) notifyTableStatusChanged(table);
    }

    return { success: true };
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
