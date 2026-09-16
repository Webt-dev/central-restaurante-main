import { db } from '../config/database.js';
import { MenuItem, MenuItemIngredientDetail } from '../models/types.js';
import { randomUUID } from 'node:crypto';

export class MenuItemRepository {
  static findAll(): MenuItem[] {
    const items = db.prepare('SELECT * FROM menu_items WHERE active = 1 ORDER BY category ASC, name ASC').all() as MenuItem[];

    const getIngredients = db.prepare(`
      SELECT mii.id, mii.menu_item_id, mii.inventory_id, mii.quantity_required, i.name as ingredient_name, i.unit, i.quantity as available_quantity
      FROM menu_item_ingredients mii
      JOIN inventory i ON i.id = mii.inventory_id
      WHERE mii.menu_item_id = ?
    `);

    return items.map((item) => ({
      ...item,
      active: Boolean(item.active),
      ingredients: getIngredients.all(item.id) as MenuItemIngredientDetail[]
    }));
  }

  static findById(id: string): MenuItem | null {
    let item = db.prepare('SELECT * FROM menu_items WHERE id = ?').get(id) as MenuItem | undefined;

    // Fallback gracioso para IDs m1, m2, m3, m4, m5, m6 se o item for procurado por ID alternativo ou nome
    if (!item && id.startsWith('m')) {
      const allItems = this.findAll();
      const indexMap: Record<string, number> = { 'm1': 0, 'm2': 1, 'm3': 2, 'm4': 3, 'm5': 4, 'm6': 5 };
      const idx = indexMap[id];
      if (idx !== undefined && allItems[idx]) {
        item = allItems[idx];
      }
    }

    if (!item) return null;

    const ingredients = db.prepare(`
      SELECT mii.id, mii.menu_item_id, mii.inventory_id, mii.quantity_required, i.name as ingredient_name, i.unit, i.quantity as available_quantity
      FROM menu_item_ingredients mii
      JOIN inventory i ON i.id = mii.inventory_id
      WHERE mii.menu_item_id = ?
    `).all(item.id) as MenuItemIngredientDetail[];

    return {
      ...item,
      active: Boolean(item.active),
      ingredients
    };
  }

  static create(item: Omit<MenuItem, 'created_at'>, ingredients: { inventory_id: string; quantity_required: number }[]): MenuItem {
    db.prepare(`
      INSERT INTO menu_items (id, name, description, price, category, active)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(item.id, item.name, item.description, item.price, item.category, item.active ? 1 : 0);

    const insertIng = db.prepare(`
      INSERT INTO menu_item_ingredients (id, menu_item_id, inventory_id, quantity_required)
      VALUES (?, ?, ?, ?)
    `);

    for (const ing of ingredients) {
      insertIng.run(randomUUID(), item.id, ing.inventory_id, ing.quantity_required);
    }

    return this.findById(item.id)!;
  }
}
