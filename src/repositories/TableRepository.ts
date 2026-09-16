import { db } from '../config/database.js';
import { Table, TableStatus } from '../models/types.js';

export class TableRepository {
  static findAll(): Table[] {
    return db.prepare('SELECT * FROM tables ORDER BY number ASC').all() as Table[];
  }

  static findById(id: string): Table | null {
    let table = db.prepare('SELECT * FROM tables WHERE id = ?').get(id) as Table | undefined;

    // Fallback gracioso para IDs t1..t10
    if (!table && id.startsWith('t')) {
      const num = parseInt(id.replace('t', ''), 10);
      if (!isNaN(num)) {
        table = this.findByNumber(num) || undefined;
      }
    }

    return table || null;
  }

  static findByNumber(number: number): Table | null {
    const table = db.prepare('SELECT * FROM tables WHERE number = ?').get(number) as Table | undefined;
    return table || null;
  }

  static updateStatus(id: string, status: TableStatus): Table | null {
    const table = this.findById(id);
    if (!table) return null;

    db.prepare(`
      UPDATE tables 
      SET status = ?, updated_at = datetime('now', 'localtime')
      WHERE id = ?
    `).run(status, table.id);

    return this.findById(table.id);
  }

  static create(table: Omit<Table, 'created_at' | 'updated_at'>): Table {
    db.prepare(`
      INSERT INTO tables (id, number, name, status)
      VALUES (?, ?, ?, ?)
    `).run(table.id, table.number, table.name, table.status || 'FREE');

    return this.findById(table.id)!;
  }
}
