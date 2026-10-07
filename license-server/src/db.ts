import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export type Db = Database.Database;

/** Abre (e cria, se preciso) o banco do servidor de licenças. */
export function openDb(file: string): Db {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      document TEXT,
      plan TEXT NOT NULL,
      features TEXT NOT NULL DEFAULT '[]',
      max_devices INTEGER NOT NULL DEFAULT 1,
      -- Data (AAAA-MM-DD) até quando o cliente já tem direito, antes de qualquer pagamento
      -- registrado aqui (ex.: primeiro mês cortesia). O vencimento efetivo é o maior entre
      -- esta data e a cobertura dos pagamentos válidos.
      base_paid_until TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'CANCELLED')),
      activation_code_hash TEXT NOT NULL,
      -- Assinatura (preapproval) do cliente no Mercado Pago.
      mp_preapproval_id TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS devices (
      client_id TEXT NOT NULL REFERENCES clients(id),
      hw TEXT NOT NULL,
      activated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      last_seen_at TEXT,
      PRIMARY KEY (client_id, hw)
    );

    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id TEXT NOT NULL REFERENCES clients(id),
      gateway TEXT NOT NULL,
      gateway_payment_id TEXT NOT NULL UNIQUE,
      amount REAL NOT NULL,
      due_date TEXT,
      -- Até quando este pagamento cobre (AAAA-MM-DD).
      period_until TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PAID' CHECK (status IN ('PAID', 'REFUNDED')),
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS idx_payments_client ON payments(client_id);
    CREATE INDEX IF NOT EXISTS idx_clients_preapproval ON clients(mp_preapproval_id);
  `);
  return db;
}
