import { db } from '../config/database.js';
import { Order, OrderItem, OrderStatus, OrderItemStatus, TableBillSummary } from '../models/types.js';
import { InventoryRepository } from './InventoryRepository.js';
import { MenuItemRepository } from './MenuItemRepository.js';
import { TableRepository } from './TableRepository.js';
import { randomUUID } from 'node:crypto';
import { HttpError } from '../utils/httpError.js';
import { lineTotal, sumReais, toCents, toReais } from '../utils/money.js';

/** Quem está alterando o pedido e, se houver, o supervisor que autorizou com PIN. */
export interface OrderActor {
  userId: string;
  role: string;
  supervisorId?: string;
}

/**
 * Item ainda não iniciado pela cozinha: garçom e caixa podem alterar.
 * Item em preparo/pronto/entregue: só ADMIN, ou com PIN de supervisor.
 */
function assertCanChange(item: OrderItem, actor: OrderActor): void {
  if (item.status === 'PENDING' || actor.role === 'ADMIN' || actor.supervisorId) return;
  throw new HttpError(403, 'Este item já está em preparo. É preciso o PIN do supervisor.', 'SUPERVISOR_REQUIRED');
}

export class OrderRepository {
  static findById(id: string): Order | null {
    const order = db.prepare(`
      SELECT o.*, t.number as table_number, u.name as waiter_name
      FROM orders o
      JOIN tables t ON t.id = o.table_id
      JOIN users u ON u.id = o.waiter_id
      WHERE o.id = ?
    `).get(id) as (Order & { table_number: number; waiter_name: string }) | undefined;

    if (!order) return null;

    const items = db.prepare(`
      SELECT oi.*, mi.name as menu_item_name
      FROM order_items oi
      JOIN menu_items mi ON mi.id = oi.menu_item_id
      WHERE oi.order_id = ?
    `).all(order.id) as OrderItem[];

    return { ...order, items };
  }

  static findByOfflineSyncId(offlineSyncId: string): Order | null {
    const order = db.prepare('SELECT * FROM orders WHERE offline_sync_id = ?').get(offlineSyncId) as Order | undefined;
    if (!order) return null;
    return this.findById(order.id);
  }

  static findOpenOrdersByTable(tableId: string): Order[] {
    const orders = db.prepare(`
      SELECT o.*, t.number as table_number, u.name as waiter_name
      FROM orders o
      JOIN tables t ON t.id = o.table_id
      JOIN users u ON u.id = o.waiter_id
      WHERE o.table_id = ? AND o.status IN ('OPEN', 'PREPARING', 'READY', 'DELIVERED')
      ORDER BY o.created_at ASC
    `).all(tableId) as (Order & { table_number: number; waiter_name: string })[];

    const getItems = db.prepare(`
      SELECT oi.*, mi.name as menu_item_name
      FROM order_items oi
      JOIN menu_items mi ON mi.id = oi.menu_item_id
      WHERE oi.order_id = ?
    `);

    return orders.map(order => ({
      ...order,
      items: getItems.all(order.id) as OrderItem[]
    }));
  }

  static findKitchenOrders(): Order[] {
    // Fila da Cozinha: apenas pedidos que contêm pratos/comidas
    const orders = db.prepare(`
      SELECT DISTINCT o.*, t.number as table_number, u.name as waiter_name
      FROM orders o
      JOIN tables t ON t.id = o.table_id
      JOIN users u ON u.id = o.waiter_id
      JOIN order_items oi ON oi.order_id = o.id
      JOIN menu_items mi ON mi.id = oi.menu_item_id
      WHERE oi.status IN ('PENDING', 'PREPARING') 
        AND o.status NOT IN ('CLOSED', 'CANCELLED')
        AND mi.category NOT IN ('Bebidas', 'Drinks do Bar', 'Drinks', 'Bar', 'Bebida')
        AND mi.category NOT LIKE '%Drink%'
        AND mi.category NOT LIKE '%Bebida%'
      ORDER BY o.created_at ASC
    `).all() as (Order & { table_number: number; waiter_name: string })[];

    const getItems = db.prepare(`
      SELECT oi.*, mi.name as menu_item_name, mi.category
      FROM order_items oi
      JOIN menu_items mi ON mi.id = oi.menu_item_id
      WHERE oi.order_id = ? AND oi.status IN ('PENDING', 'PREPARING', 'READY') 
        AND mi.category NOT IN ('Bebidas', 'Drinks do Bar', 'Drinks', 'Bar', 'Bebida')
        AND mi.category NOT LIKE '%Drink%'
        AND mi.category NOT LIKE '%Bebida%'
    `);

    return orders.map(order => ({
      ...order,
      items: getItems.all(order.id) as OrderItem[]
    }));
  }

  static findBarOrders(): Order[] {
    // Fila do Bar: apenas pedidos que contêm bebidas e drinks
    const orders = db.prepare(`
      SELECT DISTINCT o.*, t.number as table_number, u.name as waiter_name
      FROM orders o
      JOIN tables t ON t.id = o.table_id
      JOIN users u ON u.id = o.waiter_id
      JOIN order_items oi ON oi.order_id = o.id
      JOIN menu_items mi ON mi.id = oi.menu_item_id
      WHERE oi.status IN ('PENDING', 'PREPARING') 
        AND o.status NOT IN ('CLOSED', 'CANCELLED')
        AND (mi.category IN ('Bebidas', 'Drinks do Bar', 'Drinks', 'Bar', 'Bebida') OR mi.category LIKE '%Drink%' OR mi.category LIKE '%Bebida%')
      ORDER BY o.created_at ASC
    `).all() as (Order & { table_number: number; waiter_name: string })[];

    const getItems = db.prepare(`
      SELECT oi.*, mi.name as menu_item_name, mi.category
      FROM order_items oi
      JOIN menu_items mi ON mi.id = oi.menu_item_id
      WHERE oi.order_id = ? AND oi.status IN ('PENDING', 'PREPARING', 'READY') 
        AND (mi.category IN ('Bebidas', 'Drinks do Bar', 'Drinks', 'Bar', 'Bebida') OR mi.category LIKE '%Drink%' OR mi.category LIKE '%Bebida%')
    `);

    return orders.map(order => ({
      ...order,
      items: getItems.all(order.id) as OrderItem[]
    }));
  }

  /**
   * Cria o pedido inteiro numa única transação: validação, baixa de estoque e
   * gravação. Se qualquer item falhar, nada é gravado e nenhum estoque é
   * baixado (antes a baixa acontecia item a item, fora da transação, e um
   * erro no 2º item deixava o 1º descontado para sempre).
   */
  static createOrder(
    orderData: { table_id: string; waiter_id: string; notes?: string; offline_sync_id?: string },
    itemsData: { menu_item_id: string; quantity: number; notes?: string }[]
  ): { order: Order | null; error?: string } {
    if (orderData.offline_sync_id) {
      const existing = this.findByOfflineSyncId(orderData.offline_sync_id);
      if (existing) {
        return { order: existing };
      }
    }

    const orderId = randomUUID();

    try {
      db.transaction(() => {
        // Repetido dentro da transação: dois envios simultâneos do mesmo pedido offline não duplicam.
        if (orderData.offline_sync_id && this.findByOfflineSyncId(orderData.offline_sync_id)) {
          throw new HttpError(409, 'DUPLICATE_SYNC');
        }

        const table = TableRepository.findById(orderData.table_id);
        if (!table) throw new HttpError(404, 'Mesa não encontrada.');

        let totalCents = 0;
        const preparedItems: { id: string; menu_item_id: string; quantity: number; unit_price: number; total_price: number; notes?: string }[] = [];

        for (const item of itemsData) {
          const menuItem = MenuItemRepository.findById(item.menu_item_id);
          if (!menuItem || !menuItem.active) {
            throw new HttpError(400, `Item do cardápio '${item.menu_item_id}' não encontrado ou inativo.`);
          }
          const total_price = lineTotal(menuItem.price, item.quantity);
          totalCents += toCents(total_price);
          preparedItems.push({
            id: randomUUID(),
            menu_item_id: item.menu_item_id,
            quantity: item.quantity,
            unit_price: menuItem.price,
            total_price,
            notes: item.notes
          });
        }

        InventoryRepository.assertAvailable(itemsData);

        db.prepare(`
          INSERT INTO orders (id, table_id, waiter_id, status, total_amount, notes, offline_sync_id)
          VALUES (?, ?, ?, 'OPEN', ?, ?, ?)
        `).run(orderId, orderData.table_id, orderData.waiter_id, toReais(totalCents), orderData.notes || null, orderData.offline_sync_id || null);

        const insertItem = db.prepare(`
          INSERT INTO order_items (id, order_id, menu_item_id, quantity, unit_price, total_price, notes, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING')
        `);

        for (const pi of preparedItems) {
          insertItem.run(pi.id, orderId, pi.menu_item_id, pi.quantity, pi.unit_price, pi.total_price, pi.notes || null);
          InventoryRepository.consumeForOrderItem(pi.id, pi.menu_item_id, pi.quantity, orderData.waiter_id);
        }

        if (table.status === 'FREE') {
          TableRepository.updateStatus(table.id, 'OCCUPIED');
        }
      })();
    } catch (err: any) {
      if (err instanceof HttpError && err.message === 'DUPLICATE_SYNC') {
        return { order: this.findByOfflineSyncId(orderData.offline_sync_id!) };
      }
      if (err instanceof HttpError) return { order: null, error: err.message };
      throw err;
    }

    return { order: this.findById(orderId) };
  }

  static updateOrderStatus(orderId: string, status: OrderStatus): Order | null {
    db.prepare(`
      UPDATE orders 
      SET status = ?, updated_at = datetime('now', 'localtime')
      WHERE id = ?
    `).run(status, orderId);

    return this.findById(orderId);
  }

  static updateOrderItemStatus(itemId: string, status: OrderItemStatus): OrderItem | null {
    db.prepare(`
      UPDATE order_items
      SET status = ?
      WHERE id = ?
    `).run(status, itemId);

    const item = db.prepare('SELECT * FROM order_items WHERE id = ?').get(itemId) as OrderItem | undefined;
    return item || null;
  }

  // Atualização em lote de todos os itens de um pedido com 1 único clique no card
  static updateOrderItemsStatusBatch(orderId: string, status: OrderItemStatus, filterType?: 'FOOD' | 'DRINK' | 'BAR'): Order | null {
    if (filterType === 'FOOD') {
      db.prepare(`
        UPDATE order_items
        SET status = ?
        WHERE order_id = ? AND menu_item_id IN (
          SELECT id FROM menu_items 
          WHERE category NOT IN ('Bebidas', 'Drinks do Bar', 'Drinks', 'Bar', 'Bebida')
            AND category NOT LIKE '%Drink%'
            AND category NOT LIKE '%Bebida%'
        )
      `).run(status, orderId);
    } else if (filterType === 'DRINK' || filterType === 'BAR') {
      db.prepare(`
        UPDATE order_items
        SET status = ?
        WHERE order_id = ? AND menu_item_id IN (
          SELECT id FROM menu_items 
          WHERE category IN ('Bebidas', 'Drinks do Bar', 'Drinks', 'Bar', 'Bebida')
             OR category LIKE '%Drink%'
             OR category LIKE '%Bebida%'
        )
      `).run(status, orderId);
    } else {
      db.prepare(`
        UPDATE order_items
        SET status = ?
        WHERE order_id = ?
      `).run(status, orderId);
    }

    const order = this.findById(orderId);
    if (order && order.items) {
      const allReady = order.items.every(i => i.status === 'READY' || i.status === 'DELIVERED' || i.status === 'CANCELLED');
      const anyPreparing = order.items.some(i => i.status === 'PREPARING');

      if (allReady) {
        this.updateOrderStatus(orderId, 'READY');
      } else if (anyPreparing) {
        this.updateOrderStatus(orderId, 'PREPARING');
      }
    }

    return this.findById(orderId);
  }

  /** Recalcula o total do pedido ignorando itens cancelados; cancela o pedido se não sobrar nada. */
  private static recalcOrder(orderId: string): void {
    const prices = db.prepare(
      "SELECT total_price FROM order_items WHERE order_id = ? AND status != 'CANCELLED'"
    ).all(orderId) as { total_price: number }[];
    db.prepare("UPDATE orders SET total_amount = ?, updated_at = datetime('now', 'localtime') WHERE id = ?")
      .run(sumReais(prices.map(p => p.total_price)), orderId);

    const { count } = db.prepare(
      "SELECT COUNT(*) as count FROM order_items WHERE order_id = ? AND status != 'CANCELLED'"
    ).get(orderId) as { count: number };
    if (count === 0) {
      db.prepare("UPDATE orders SET status = 'CANCELLED', updated_at = datetime('now', 'localtime') WHERE id = ?").run(orderId);
    }
  }

  private static loadEditableItem(itemId: string): { item: OrderItem; order: Order } {
    const item = db.prepare('SELECT * FROM order_items WHERE id = ?').get(itemId) as OrderItem | undefined;
    if (!item) throw new HttpError(404, 'Item do pedido não encontrado.');
    if (item.status === 'CANCELLED') throw new HttpError(409, 'Este item já foi cancelado.');

    const order = this.findById(item.order_id);
    if (!order) throw new HttpError(404, 'Pedido não encontrado.');
    if (order.status === 'CLOSED' || order.status === 'CANCELLED') {
      throw new HttpError(409, 'Não é possível alterar um pedido já fechado.');
    }
    return { item, order };
  }

  /**
   * Cancela um item (nunca apaga): grava quem, quando e o motivo, devolve o
   * estoque e recalcula o total. O garçom só cancela item que a cozinha ainda
   * não começou; depois disso, só caixa ou gestão.
   */
  static cancelOrderItem(itemId: string, actor: OrderActor, reason?: string): { table_id: string; before: OrderItem } {
    const { item, order } = this.loadEditableItem(itemId);
    assertCanChange(item, actor);

    db.transaction(() => {
      db.prepare(`
        UPDATE order_items
        SET status = 'CANCELLED', cancelled_at = datetime('now', 'localtime'), cancelled_by = ?, cancel_reason = ?
        WHERE id = ?
      `).run(actor.userId, reason?.trim() || null, itemId);
      InventoryRepository.restoreForOrderItem(itemId, item.quantity, item.quantity, actor.userId, reason);
      this.recalcOrder(order.id);
    })();

    return { table_id: order.table_id, before: item };
  }

  static updateOrderItemQuantity(itemId: string, quantity: number, actor: OrderActor, reason?: string): { table_id: string; before: OrderItem } {
    if (quantity <= 0) return this.cancelOrderItem(itemId, actor, reason);

    const { item, order } = this.loadEditableItem(itemId);
    assertCanChange(item, actor);
    if (quantity === item.quantity) return { table_id: order.table_id, before: item };

    db.transaction(() => {
      if (quantity > item.quantity) {
        const extra = [{ menu_item_id: item.menu_item_id, quantity: quantity - item.quantity }];
        InventoryRepository.assertAvailable(extra);
        InventoryRepository.consumeForOrderItem(itemId, item.menu_item_id, quantity - item.quantity, actor.userId);
      } else {
        InventoryRepository.restoreForOrderItem(itemId, item.quantity - quantity, item.quantity, actor.userId, reason);
      }

      const newTotalPrice = lineTotal(item.unit_price, quantity);
      db.prepare('UPDATE order_items SET quantity = ?, total_price = ? WHERE id = ?').run(quantity, newTotalPrice, itemId);
      this.recalcOrder(order.id);
    })();

    return { table_id: order.table_id, before: item };
  }

  static getTableBill(tableId: string): TableBillSummary | null {
    const table = TableRepository.findById(tableId);
    if (!table) return null;

    const orders = this.findOpenOrdersByTable(tableId);
    let totalCents = 0;

    const itemsMap = new Map<string, { menu_item_id: string; name: string; quantity: number; unit_price: number; total_price: number }>();

    // O total vem dos itens não cancelados (inclusive os cancelados pela
    // cozinha), não do total_amount gravado no pedido.
    for (const order of orders) {
      if (order.status !== 'CANCELLED') {
        if (order.items) {
          for (const item of order.items) {
            if (item.status !== 'CANCELLED') {
              totalCents += toCents(item.total_price);
              const existing = itemsMap.get(item.menu_item_id);
              if (existing) {
                existing.quantity += item.quantity;
                existing.total_price = sumReais([existing.total_price, item.total_price]);
              } else {
                itemsMap.set(item.menu_item_id, {
                  menu_item_id: item.menu_item_id,
                  name: item.menu_item_name || 'Item',
                  quantity: item.quantity,
                  unit_price: item.unit_price,
                  total_price: item.total_price
                });
              }
            }
          }
        }
      }
    }

    return {
      table,
      orders,
      total_amount: toReais(totalCents),
      items_summary: Array.from(itemsMap.values())
    };
  }
}
