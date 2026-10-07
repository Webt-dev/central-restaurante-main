import { db } from '../config/database.js';
import { randomUUID } from 'node:crypto';
import { Table, MenuItem, InventoryItem } from '../models/types.js';
import { InventoryRepository, MovementContext } from './InventoryRepository.js';

export interface RestaurantSettings {
  restaurant_name: string;
  cnpj: string;
  phone: string;
  address: string;
  service_tax_percent: number;
  payment_methods_allowed: string[];
  /** Tema da interface, escolhido pelo ADMIN e aplicado em todos os aparelhos. */
  theme: ThemePreference;
}

export type ThemePreference = 'light' | 'dark' | 'system';
const VALID_THEMES: ThemePreference[] = ['light', 'dark', 'system'];

const VALID_PAYMENT_METHODS = ['CASH', 'CREDIT_CARD', 'DEBIT_CARD', 'PIX'];

export class AdminRepository {
  // ==========================================
  // 1. GESTÃO DE MESAS
  // ==========================================
  static addTable(number: number, name?: string): Table {
    const existing = db.prepare('SELECT * FROM tables WHERE number = ?').get(number);
    if (existing) {
      throw new Error(`A mesa número ${number} já existe!`);
    }

    const id = `t${number}_${randomUUID().substring(0, 4)}`;
    const tableName = name && name.trim() ? name.trim() : `Mesa ${String(number).padStart(2, '0')}`;

    db.prepare(`
      INSERT INTO tables (id, number, name, status)
      VALUES (?, ?, ?, 'FREE')
    `).run(id, number, tableName);

    return db.prepare('SELECT * FROM tables WHERE id = ?').get(id) as Table;
  }

  static updateTable(id: string, number: number, name: string): Table {
    const existingNum = db.prepare('SELECT * FROM tables WHERE number = ? AND id != ?').get(number, id);
    if (existingNum) {
      throw new Error(`O número de mesa ${number} já está em uso por outra mesa!`);
    }

    db.prepare(`
      UPDATE tables
      SET number = ?, name = ?, updated_at = datetime('now', 'localtime')
      WHERE id = ?
    `).run(number, name, id);

    return db.prepare('SELECT * FROM tables WHERE id = ?').get(id) as Table;
  }

  static deleteTable(id: string): void {
    const table = db.prepare('SELECT * FROM tables WHERE id = ?').get(id) as Table | undefined;
    if (!table) {
      throw new Error('Mesa não encontrada.');
    }
    if (table.status !== 'FREE') {
      throw new Error('Não é possível remover uma mesa que está ocupada ou com pagamento pendente!');
    }

    const hasOrders = db.prepare("SELECT count(*) as count FROM orders WHERE table_id = ? AND status != 'CLOSED' AND status != 'CANCELLED'").get(id) as any;
    if (hasOrders && hasOrders.count > 0) {
      throw new Error('Não é possível excluir uma mesa que possui pedidos abertos!');
    }

    db.prepare('DELETE FROM tables WHERE id = ?').run(id);
  }

  // ==========================================
  // 2. GESTÃO DO CARDÁPIO
  // ==========================================
  static addMenuItem(data: { name: string; description: string; price: number; category: string }): MenuItem {
    const id = `m_${randomUUID().substring(0, 6)}`;
    db.prepare(`
      INSERT INTO menu_items (id, name, description, price, category, active)
      VALUES (?, ?, ?, ?, ?, 1)
    `).run(id, data.name, data.description || '', data.price, data.category);

    return db.prepare('SELECT * FROM menu_items WHERE id = ?').get(id) as MenuItem;
  }

  static updateMenuItem(id: string, data: { name: string; description: string; price: number; category: string; active?: boolean }): MenuItem {
    db.prepare(`
      UPDATE menu_items
      SET name = ?, description = ?, price = ?, category = ?, active = ?
      WHERE id = ?
    `).run(data.name, data.description || '', data.price, data.category, data.active !== false ? 1 : 0, id);

    return db.prepare('SELECT * FROM menu_items WHERE id = ?').get(id) as MenuItem;
  }

  /**
   * Item já vendido é arquivado (some do cardápio, mas os pedidos antigos
   * continuam apontando para ele). Item nunca vendido é apagado de fato.
   */
  static deleteMenuItem(id: string): void {
    const sold = db.prepare('SELECT 1 FROM order_items WHERE menu_item_id = ? LIMIT 1').get(id);
    if (sold) {
      db.prepare("UPDATE menu_items SET active = 0, archived_at = datetime('now', 'localtime') WHERE id = ?").run(id);
    } else {
      db.prepare('DELETE FROM menu_items WHERE id = ?').run(id);
    }
  }

  // ==========================================
  // 3. CATEGORIAS
  // ==========================================
  static getCategories(): string[] {
    const rows = db.prepare('SELECT DISTINCT category FROM menu_items ORDER BY category ASC').all() as { category: string }[];
    return rows.map(r => r.category);
  }

  // ==========================================
  // 4. ESTOQUE
  // ==========================================
  // Toda alteração de saldo passa pelo InventoryRepository, que registra a
  // movimentação (quem, quando, quanto e por quê).
  static addInventoryItem(data: { name: string; unit: string; quantity: number; min_quantity: number; unit_price: number }, ctx: MovementContext = {}): InventoryItem {
    const id = `inv_${randomUUID().substring(0, 6)}`;
    return InventoryRepository.create({ id, ...data }, ctx);
  }

  static updateInventoryItem(id: string, data: { name: string; unit: string; quantity: number; min_quantity: number; unit_price: number }, ctx: MovementContext = {}): InventoryItem {
    return InventoryRepository.update(id, data, ctx)!;
  }

  static restockItem(id: string, addedQuantity: number, ctx: MovementContext = {}): InventoryItem {
    InventoryRepository.updateQuantity(id, addedQuantity, 'RESTOCK', ctx);
    return InventoryRepository.findById(id)!;
  }

  /** Insumo é arquivado (o histórico de movimentações continua) e sai das fichas técnicas. */
  static deleteInventoryItem(id: string): void {
    db.transaction(() => {
      db.prepare('DELETE FROM menu_item_ingredients WHERE inventory_id = ?').run(id);
      db.prepare("UPDATE inventory SET archived_at = datetime('now', 'localtime') WHERE id = ?").run(id);
    })();
  }

  // ==========================================
  // 5. CONFIGURAÇÕES DO RESTAURANTE
  // ==========================================
  static getSettings(): RestaurantSettings {
    const rows = db.prepare('SELECT key, value FROM restaurant_settings').all() as { key: string; value: string }[];
    const settingsMap: Record<string, string> = {};
    rows.forEach(r => { settingsMap[r.key] = r.value; });

    return {
      restaurant_name: settingsMap['restaurant_name'] || 'Central Restaurante',
      cnpj: settingsMap['cnpj'] ?? '',
      phone: settingsMap['phone'] ?? '',
      address: settingsMap['address'] ?? '',
      service_tax_percent: Number(settingsMap['service_tax_percent'] ?? 10),
      payment_methods_allowed: parsePaymentMethods(settingsMap['payment_methods_allowed']),
      theme: VALID_THEMES.includes(settingsMap['theme'] as ThemePreference) ? (settingsMap['theme'] as ThemePreference) : 'system'
    };
  }

  static updateSettings(data: Partial<RestaurantSettings>): RestaurantSettings {
    const upsert = db.prepare(`
      INSERT INTO restaurant_settings (key, value, updated_at)
      VALUES (?, ?, datetime('now', 'localtime'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);

    if (data.restaurant_name !== undefined) upsert.run('restaurant_name', data.restaurant_name);
    if (data.cnpj !== undefined) upsert.run('cnpj', data.cnpj);
    if (data.phone !== undefined) upsert.run('phone', data.phone);
    if (data.address !== undefined) upsert.run('address', data.address);
    if (data.service_tax_percent !== undefined) upsert.run('service_tax_percent', String(data.service_tax_percent));
    if (data.theme !== undefined && VALID_THEMES.includes(data.theme)) upsert.run('theme', data.theme);

    if (data.payment_methods_allowed !== undefined) {
      // Normaliza: só métodos válidos, sem duplicados, sempre com dinheiro.
      const cleaned = Array.from(
        new Set(
          ['CASH', ...data.payment_methods_allowed.map(m => String(m).trim().toUpperCase())]
            .filter(m => VALID_PAYMENT_METHODS.includes(m))
        )
      );
      upsert.run('payment_methods_allowed', cleaned.join(','));
    }

    return this.getSettings();
  }
}

/**
 * Lê a lista de formas de pagamento salva.
 *
 * Antes usava `settingsMap[...] || 'CASH,CREDIT_CARD,DEBIT_CARD,PIX'`. Se o
 * gerente desmarcasse tudo, o valor salvo virava string vazia — que é falsy —
 * e o sistema reativava TODAS as formas silenciosamente. Agora só voltamos ao
 * padrão quando a chave realmente não existe.
 */
function parsePaymentMethods(raw: string | undefined): string[] {
  if (raw === undefined || raw === null) {
    return [...VALID_PAYMENT_METHODS];
  }

  const parsed = raw
    .split(',')
    .map(m => m.trim().toUpperCase())
    .filter(m => VALID_PAYMENT_METHODS.includes(m));

  // Dinheiro é obrigatório por lei: nunca devolvemos uma lista sem ele.
  if (!parsed.includes('CASH')) parsed.unshift('CASH');

  return Array.from(new Set(parsed));
}
