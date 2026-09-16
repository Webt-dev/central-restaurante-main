import { db } from '../config/database.js';
import { User, UserRole } from '../models/types.js';

export class UserRepository {
  static findByUsername(username: string): User | null {
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as User | undefined;
    return user || null;
  }

  static findById(id: string): User | null {
    const user = db.prepare('SELECT id, name, username, role, password_hash, created_at FROM users WHERE id = ?').get(id) as User | undefined;
    return user || null;
  }

  static listAll(): Omit<User, 'password_hash'>[] {
    return db.prepare('SELECT id, name, username, role, created_at FROM users ORDER BY name ASC').all() as Omit<User, 'password_hash'>[];
  }

  static create(user: Omit<User, 'created_at'>): User {
    db.prepare(`
      INSERT INTO users (id, name, username, role, password_hash)
      VALUES (?, ?, ?, ?, ?)
    `).run(user.id, user.name, user.username, user.role, user.password_hash);

    return this.findById(user.id)!;
  }

  static updatePassword(id: string, newHash: string): void {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, id);
  }
}
