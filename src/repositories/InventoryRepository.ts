import { db } from '../config/database.js';
import { InventoryItem } from '../models/types.js';
import { HttpError } from '../utils/httpError.js';

export type StockReason = 'SALE' | 'SALE_CANCEL' | 'RESTOCK' | 'ADJUST' | 'CREATE';

export interface MovementContext {
  userId?: string | null;
  orderItemId?: string | null;
  note?: string | null;
}

interface IngredientNeed {
  inventory_id: string;
  ingredient_name: string;
  current_quantity: number;
  needed: number;
}

export class InventoryRepository {
  static findAll(): InventoryItem[] {
    return db.prepare('SELECT * FROM inventory WHERE archived_at IS NULL ORDER BY name ASC').all() as InventoryItem[];
  }

  static findById(id: string): InventoryItem | null {
    const item = db.prepare('SELECT * FROM inventory WHERE id = ?').get(id) as InventoryItem | undefined;
    return item || null;
  }

  static findLowStock(): InventoryItem[] {
    return db.prepare('SELECT * FROM inventory WHERE archived_at IS NULL AND quantity <= min_quantity ORDER BY quantity ASC').all() as InventoryItem[];
  }

  static create(item: Omit<InventoryItem, 'created_at' | 'updated_at'>, ctx: MovementContext = {}): InventoryItem {
    db.transaction(() => {
      db.prepare(`
        INSERT INTO inventory (id, name, unit, quantity, min_quantity, unit_price)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(item.id, item.name, item.unit, item.quantity, item.min_quantity, item.unit_price);
      if (item.quantity) this.recordMovement(item.id, item.quantity, 'CREATE', ctx);
    })();

    return this.findById(item.id)!;
  }

  static update(id: string, data: Partial<Omit<InventoryItem, 'id' | 'created_at' | 'updated_at'>>, ctx: MovementContext = {}): InventoryItem | null {
    const current = this.findById(id);
    if (!current) return null;

    const quantity = data.quantity ?? current.quantity;

    db.transaction(() => {
      db.prepare(`
        UPDATE inventory
        SET name = ?, unit = ?, quantity = ?, min_quantity = ?, unit_price = ?, updated_at = datetime('now', 'localtime')
        WHERE id = ?
      `).run(
        data.name ?? current.name,
        data.unit ?? current.unit,
        quantity,
        data.min_quantity ?? current.min_quantity,
        data.unit_price ?? current.unit_price,
        id
      );
      const delta = quantity - current.quantity;
      if (delta !== 0) this.recordMovement(id, delta, 'ADJUST', ctx);
    })();

    return this.findById(id);
  }

  /** Soma (ou subtrai) do saldo e registra a movimentação. */
  static updateQuantity(id: string, deltaQuantity: number, reason: StockReason = 'ADJUST', ctx: MovementContext = {}): void {
    db.transaction(() => {
      db.prepare(`
        UPDATE inventory
        SET quantity = quantity + ?, updated_at = datetime('now', 'localtime')
        WHERE id = ?
      `).run(deltaQuantity, id);
      this.recordMovement(id, deltaQuantity, reason, ctx);
    })();
  }

  static recordMovement(inventoryId: string, delta: number, reason: StockReason, ctx: MovementContext = {}): void {
    db.prepare(`
      INSERT INTO inventory_movements (inventory_id, delta, reason, order_item_id, user_id, note)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(inventoryId, delta, reason, ctx.orderItemId ?? null, ctx.userId ?? null, ctx.note ?? null);
  }

  /**
   * Quanto de cada insumo um conjunto de itens consome, já somando itens que
   * usam o mesmo insumo (antes cada item era checado isoladamente, e dois
   * lanches com o mesmo pão podiam passar na checagem e deixar o saldo negativo).
   */
  static requirementsFor(items: { menu_item_id: string; quantity: number }[]): IngredientNeed[] {
    const recipe = db.prepare(`
      SELECT mii.inventory_id, mii.quantity_required, i.name as ingredient_name, i.quantity as current_quantity
      FROM menu_item_ingredients mii
      JOIN inventory i ON i.id = mii.inventory_id
      WHERE mii.menu_item_id = ?
    `);

    const needs = new Map<string, IngredientNeed>();
    for (const item of items) {
      const rows = recipe.all(item.menu_item_id) as { inventory_id: string; quantity_required: number; ingredient_name: string; current_quantity: number }[];
      for (const r of rows) {
        const existing = needs.get(r.inventory_id);
        const add = r.quantity_required * item.quantity;
        if (existing) existing.needed += add;
        else needs.set(r.inventory_id, { inventory_id: r.inventory_id, ingredient_name: r.ingredient_name, current_quantity: r.current_quantity, needed: add });
      }
    }
    return [...needs.values()];
  }

  /** Lança HttpError 409 se algum insumo não cobrir o total pedido. */
  static assertAvailable(items: { menu_item_id: string; quantity: number }[]): void {
    for (const need of this.requirementsFor(items)) {
      if (need.current_quantity < need.needed) {
        throw new HttpError(409, `Estoque insuficiente de ${need.ingredient_name} (necessário: ${need.needed}, disponível: ${need.current_quantity}).`);
      }
    }
  }

  /**
   * Baixa de estoque da venda de um item do pedido. Deve rodar dentro da
   * transação de quem chama, depois de assertAvailable.
   */
  static consumeForOrderItem(orderItemId: string, menuItemId: string, quantity: number, userId?: string | null): void {
    for (const need of this.requirementsFor([{ menu_item_id: menuItemId, quantity }])) {
      this.updateQuantity(need.inventory_id, -need.needed, 'SALE', { orderItemId, userId });
    }
  }

  /**
   * Devolve ao estoque o que foi baixado para um item do pedido, na
   * proporção da quantidade cancelada. Usa as movimentações registradas na
   * venda (e não a ficha técnica atual, que pode ter mudado depois).
   */
  static restoreForOrderItem(orderItemId: string, cancelledQty: number, originalQty: number, userId?: string | null, note?: string): void {
    if (originalQty <= 0 || cancelledQty <= 0) return;
    const consumed = db.prepare(`
      SELECT inventory_id, -SUM(delta) as net
      FROM inventory_movements
      WHERE order_item_id = ? AND reason IN ('SALE', 'SALE_CANCEL')
      GROUP BY inventory_id
    `).all(orderItemId) as { inventory_id: string; net: number }[];

    const ratio = Math.min(1, cancelledQty / originalQty);
    for (const c of consumed) {
      const back = Number((c.net * ratio).toFixed(6));
      if (back > 0) this.updateQuantity(c.inventory_id, back, 'SALE_CANCEL', { orderItemId, userId, note });
    }
  }

  /** Consumo líquido (vendas menos cancelamentos) por insumo desde uma data/hora. */
  static consumptionSince(since: string): { id: string; name: string; unit: string; total_consumed: number }[] {
    return db.prepare(`
      SELECT inv.id, inv.name, inv.unit, -SUM(m.delta) as total_consumed
      FROM inventory_movements m
      JOIN inventory inv ON inv.id = m.inventory_id
      WHERE m.reason IN ('SALE', 'SALE_CANCEL') AND m.created_at >= ?
      GROUP BY inv.id
      HAVING total_consumed > 0
      ORDER BY inv.name
    `).all(since) as { id: string; name: string; unit: string; total_consumed: number }[];
  }
}
