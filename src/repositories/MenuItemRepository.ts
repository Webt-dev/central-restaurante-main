import { db } from '../config/database.js';
import { MenuItem, MenuItemIngredientDetail } from '../models/types.js';
import { randomUUID } from 'node:crypto';

export class MenuItemRepository {
  static findAll(): MenuItem[] {
    const items = db.prepare('SELECT * FROM menu_items WHERE active = 1 AND archived_at IS NULL ORDER BY category ASC, name ASC').all() as MenuItem[];

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
    // Sem "fallback" por posição: antes um ID desconhecido devolvia OUTRO
    // produto, com outro preço.
    const item = db.prepare('SELECT * FROM menu_items WHERE id = ? AND archived_at IS NULL').get(id) as MenuItem | undefined;
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
