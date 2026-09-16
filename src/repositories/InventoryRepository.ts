import { db } from '../config/database.js';
import { InventoryItem } from '../models/types.js';

export class InventoryRepository {
  static findAll(): InventoryItem[] {
    return db.prepare('SELECT * FROM inventory ORDER BY name ASC').all() as InventoryItem[];
  }

  static findById(id: string): InventoryItem | null {
    const item = db.prepare('SELECT * FROM inventory WHERE id = ?').get(id) as InventoryItem | undefined;
    return item || null;
  }

  static findLowStock(): InventoryItem[] {
    return db.prepare('SELECT * FROM inventory WHERE quantity <= min_quantity ORDER BY quantity ASC').all() as InventoryItem[];
  }

  static create(item: Omit<InventoryItem, 'created_at' | 'updated_at'>): InventoryItem {
    db.prepare(`
      INSERT INTO inventory (id, name, unit, quantity, min_quantity, unit_price)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(item.id, item.name, item.unit, item.quantity, item.min_quantity, item.unit_price);

    return this.findById(item.id)!;
  }

  static update(id: string, data: Partial<Omit<InventoryItem, 'id' | 'created_at' | 'updated_at'>>): InventoryItem | null {
    const current = this.findById(id);
    if (!current) return null;

    const name = data.name ?? current.name;
    const unit = data.unit ?? current.unit;
    const quantity = data.quantity ?? current.quantity;
    const min_quantity = data.min_quantity ?? current.min_quantity;
    const unit_price = data.unit_price ?? current.unit_price;

    db.prepare(`
      UPDATE inventory 
      SET name = ?, unit = ?, quantity = ?, min_quantity = ?, unit_price = ?, updated_at = datetime('now', 'localtime')
      WHERE id = ?
    `).run(name, unit, quantity, min_quantity, unit_price, id);

    return this.findById(id);
  }

  static updateQuantity(id: string, deltaQuantity: number): void {
    db.prepare(`
      UPDATE inventory 
      SET quantity = quantity + ?, updated_at = datetime('now', 'localtime')
      WHERE id = ?
    `).run(deltaQuantity, id);
  }

  // Baixa automática no estoque ao vender item do cardápio
  static deductStockForMenuItem(menuItemId: string, orderQuantity: number): { success: boolean; missingIngredient?: string } {
    const ingredients = db.prepare(`
      SELECT mi.inventory_id, mi.quantity_required, i.name as ingredient_name, i.quantity as current_quantity
      FROM menu_item_ingredients mi
      JOIN inventory i ON i.id = mi.inventory_id
      WHERE mi.menu_item_id = ?
    `).all(menuItemId) as { inventory_id: string; quantity_required: number; ingredient_name: string; current_quantity: number }[];

    // Verificar se há estoque suficiente de todos os ingredientes
    for (const ing of ingredients) {
      const needed = ing.quantity_required * orderQuantity;
      if (ing.current_quantity < needed) {
        return { success: false, missingIngredient: `${ing.ingredient_name} (Necessário: ${needed}, Disponível: ${ing.current_quantity})` };
      }
    }

    // Abater estoque em transação
    const updateStmt = db.prepare(`
      UPDATE inventory 
      SET quantity = quantity - ?, updated_at = datetime('now', 'localtime')
      WHERE id = ?
    `);

    for (const ing of ingredients) {
      const needed = ing.quantity_required * orderQuantity;
      updateStmt.run(needed, ing.inventory_id);
    }

    return { success: true };
  }
}
