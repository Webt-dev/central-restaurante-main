import { db } from '../config/database.js';
import { Order, OrderItem, OrderStatus, OrderItemStatus, TableBillSummary } from '../models/types.js';
import { InventoryRepository } from './InventoryRepository.js';
import { MenuItemRepository } from './MenuItemRepository.js';
import { TableRepository } from './TableRepository.js';
import { randomUUID } from 'node:crypto';

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

    const table = TableRepository.findById(orderData.table_id);
    if (!table) {
      return { order: null, error: 'Mesa não encontrada.' };
    }

    let calculatedTotal = 0;
    const preparedItems: { id: string; menu_item_id: string; quantity: number; unit_price: number; total_price: number; notes?: string }[] = [];

    for (const item of itemsData) {
      const menuItem = MenuItemRepository.findById(item.menu_item_id);
      if (!menuItem || !menuItem.active) {
        return { order: null, error: `Item do cardápio '${item.menu_item_id}' não encontrado ou inativo.` };
      }

      const stockCheck = InventoryRepository.deductStockForMenuItem(item.menu_item_id, item.quantity);
      if (!stockCheck.success) {
        return { order: null, error: `Estoque insuficiente para ${menuItem.name}: ${stockCheck.missingIngredient}` };
      }

      const total_price = Number((menuItem.price * item.quantity).toFixed(2));
      calculatedTotal += total_price;

      preparedItems.push({
        id: randomUUID(),
        menu_item_id: item.menu_item_id,
        quantity: item.quantity,
        unit_price: menuItem.price,
        total_price,
        notes: item.notes
      });
    }

    const orderId = randomUUID();

    const createTransaction = db.transaction(() => {
      db.prepare(`
        INSERT INTO orders (id, table_id, waiter_id, status, total_amount, notes, offline_sync_id)
        VALUES (?, ?, ?, 'OPEN', ?, ?, ?)
      `).run(orderId, orderData.table_id, orderData.waiter_id, calculatedTotal, orderData.notes || null, orderData.offline_sync_id || null);

      const insertItem = db.prepare(`
        INSERT INTO order_items (id, order_id, menu_item_id, quantity, unit_price, total_price, notes, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING')
      `);

      for (const pi of preparedItems) {
        insertItem.run(pi.id, orderId, pi.menu_item_id, pi.quantity, pi.unit_price, pi.total_price, pi.notes || null);
      }

      if (table.status === 'FREE') {
        TableRepository.updateStatus(table.id, 'OCCUPIED');
      }
    });

    createTransaction();

    const createdOrder = this.findById(orderId);
    return { order: createdOrder };
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

  static deleteOrderItem(itemId: string): { success: boolean; table_id?: string } {
    const item = db.prepare('SELECT * FROM order_items WHERE id = ?').get(itemId) as OrderItem | undefined;
    if (!item) return { success: false };

    const orderId = item.order_id;
    const order = this.findById(orderId);
    if (!order) return { success: false };

    db.prepare('DELETE FROM order_items WHERE id = ?').run(itemId);

    const newTotalObj = db.prepare('SELECT SUM(total_price) as total FROM order_items WHERE order_id = ?').get(orderId) as { total: number | null };
    const newTotal = newTotalObj.total || 0;

    db.prepare('UPDATE orders SET total_amount = ? WHERE id = ?').run(newTotal, orderId);

    const remainingItemsCount = (db.prepare('SELECT COUNT(*) as count FROM order_items WHERE order_id = ?').get(orderId) as { count: number }).count;
    if (remainingItemsCount === 0) {
      db.prepare("UPDATE orders SET status = 'CANCELLED' WHERE id = ?").run(orderId);
    }

    return { success: true, table_id: order.table_id };
  }

  static updateOrderItemQuantity(itemId: string, quantity: number): { success: boolean; table_id?: string } {
    const item = db.prepare('SELECT * FROM order_items WHERE id = ?').get(itemId) as OrderItem | undefined;
    if (!item) return { success: false };

    if (quantity <= 0) {
      return this.deleteOrderItem(itemId);
    }

    const newTotalPrice = Number((item.unit_price * quantity).toFixed(2));
    db.prepare('UPDATE order_items SET quantity = ?, total_price = ? WHERE id = ?').run(quantity, newTotalPrice, itemId);

    const orderId = item.order_id;
    const newTotalObj = db.prepare('SELECT SUM(total_price) as total FROM order_items WHERE order_id = ?').get(orderId) as { total: number | null };
    const newTotal = newTotalObj.total || 0;

    db.prepare('UPDATE orders SET total_amount = ? WHERE id = ?').run(newTotal, orderId);

    const order = this.findById(orderId);
    return { success: true, table_id: order?.table_id };
  }

  static getTableBill(tableId: string): TableBillSummary | null {
    const table = TableRepository.findById(tableId);
    if (!table) return null;

    const orders = this.findOpenOrdersByTable(tableId);
    let total_amount = 0;

    const itemsMap = new Map<string, { menu_item_id: string; name: string; quantity: number; unit_price: number; total_price: number }>();

    for (const order of orders) {
      if (order.status !== 'CANCELLED') {
        total_amount += order.total_amount;
        if (order.items) {
          for (const item of order.items) {
            if (item.status !== 'CANCELLED') {
              const existing = itemsMap.get(item.menu_item_id);
              if (existing) {
                existing.quantity += item.quantity;
                existing.total_price += item.total_price;
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
      total_amount: Number(total_amount.toFixed(2)),
      items_summary: Array.from(itemsMap.values())
    };
  }
}
