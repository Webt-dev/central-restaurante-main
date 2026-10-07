import { db } from '../config/database.js';
import { User, UserRole, PublicUser } from '../models/types.js';

const PUBLIC_COLUMNS = 'id, name, username, role, active, created_at';

export class UserRepository {
  static findByUsername(username: string): User | null {
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as User | undefined;
    return user || null;
  }

  static findById(id: string): User | null {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as User | undefined;
    return user || null;
  }

  static count(): number {
    return (db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number }).count;
  }

  static countActiveAdmins(): number {
    return (db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'ADMIN' AND active = 1").get() as { count: number }).count;
  }

  static listAll(): PublicUser[] {
    return db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM users ORDER BY active DESC, name ASC`).all() as PublicUser[];
  }

  static create(user: { id: string; name: string; username: string; role: UserRole; password_hash: string }): User {
    db.prepare(`
      INSERT INTO users (id, name, username, role, password_hash)
      VALUES (?, ?, ?, ?, ?)
    `).run(user.id, user.name, user.username, user.role, user.password_hash);

    return this.findById(user.id)!;
  }

  /**
   * Toda mudança de senha, papel ou status incrementa token_version, o que
   * derruba na hora as sessões abertas desse usuário.
   */
  static updatePassword(id: string, newHash: string): void {
    db.prepare('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?').run(newHash, id);
  }

  static updateProfile(id: string, data: { name: string; role: UserRole; active: boolean }): void {
    db.prepare(`
      UPDATE users SET name = ?, role = ?, active = ?, token_version = token_version + 1 WHERE id = ?
    `).run(data.name, data.role, data.active ? 1 : 0, id);
  }

  static setPin(id: string, pinHash: string | null): void {
    db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(pinHash, id);
  }

  static listActiveAdminsWithPin(): User[] {
    return db.prepare("SELECT * FROM users WHERE role = 'ADMIN' AND active = 1 AND pin_hash IS NOT NULL").all() as User[];
  }

  static updateUsername(id: string, username: string): void {
    db.prepare('UPDATE users SET username = ? WHERE id = ?').run(username, id);
  }
}
