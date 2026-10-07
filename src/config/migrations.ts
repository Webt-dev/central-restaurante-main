import type { Database } from 'better-sqlite3';
import { backupSync } from '../services/BackupService.js';

/**
 * Migrações numeradas, controladas por PRAGMA user_version.
 *
 * Cada migração roda uma única vez, dentro de uma transação. Para mudar o
 * esquema, acrescente uma nova entrada no fim da lista — nunca altere uma
 * migração que já foi distribuída a clientes.
 */
interface Migration {
  version: number;
  name: string;
  up: (db: Database) => void;
}

function hasColumn(db: Database, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some(c => c.name === column);
}

function addColumn(db: Database, table: string, column: string, definition: string): void {
  if (!hasColumn(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'usuarios-ativos-e-auditoria',
    up: db => {
      addColumn(db, 'users', 'active', 'INTEGER NOT NULL DEFAULT 1');
      addColumn(db, 'users', 'token_version', 'INTEGER NOT NULL DEFAULT 0');

      // Trilha de auditoria append-only com hash encadeado: alterar ou apagar
      // uma linha antiga quebra a cadeia e fica detectável.
      db.exec(`
        CREATE TABLE IF NOT EXISTS audit_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
          user_id TEXT,
          user_name TEXT,
          role TEXT,
          ip TEXT,
          action TEXT NOT NULL,
          entity TEXT,
          entity_id TEXT,
          before_json TEXT,
          after_json TEXT,
          reason TEXT,
          prev_hash TEXT NOT NULL,
          hash TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, entity_id);
        CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);

        CREATE TRIGGER IF NOT EXISTS audit_log_no_update
        BEFORE UPDATE ON audit_log
        BEGIN SELECT RAISE(ABORT, 'audit_log é somente inclusão'); END;

        CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
        BEFORE DELETE ON audit_log
        BEGIN SELECT RAISE(ABORT, 'audit_log é somente inclusão'); END;
      `);
    }
  },
  {
    version: 2,
    name: 'movimentacoes-de-estoque-e-cancelamento-logico',
    up: db => {
      // Toda entrada/saída de estoque vira uma linha: o saldo em inventory é
      // a soma dessas movimentações, e o relatório de consumo lê daqui.
      db.exec(`
        CREATE TABLE IF NOT EXISTS inventory_movements (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          inventory_id TEXT NOT NULL,
          delta REAL NOT NULL,
          reason TEXT NOT NULL CHECK(reason IN ('SALE', 'SALE_CANCEL', 'RESTOCK', 'ADJUST', 'CREATE')),
          order_item_id TEXT,
          user_id TEXT,
          note TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
          FOREIGN KEY (inventory_id) REFERENCES inventory(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_inv_mov_item ON inventory_movements(inventory_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_inv_mov_order_item ON inventory_movements(order_item_id);
        CREATE INDEX IF NOT EXISTS idx_inv_mov_created ON inventory_movements(created_at);
      `);

      // Item cancelado não é mais apagado: fica com quem, quando e por quê.
      addColumn(db, 'order_items', 'cancelled_at', 'TEXT');
      addColumn(db, 'order_items', 'cancelled_by', 'TEXT');
      addColumn(db, 'order_items', 'cancel_reason', 'TEXT');

      // Exclusão lógica de cardápio e insumos (vendas antigas apontam para eles).
      addColumn(db, 'menu_items', 'archived_at', 'TEXT');
      addColumn(db, 'inventory', 'archived_at', 'TEXT');

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_order_items_menu_status ON order_items(menu_item_id, status);
        CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id);
        CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
      `);
    }
  },
  {
    version: 3,
    name: 'pin-de-supervisor-e-conferencia-de-caixa',
    up: db => {
      // PIN numérico do supervisor (ADMIN) para autorizar cancelamentos no salão.
      addColumn(db, 'users', 'pin_hash', 'TEXT');

      // Conferência do caixa: quanto deveria haver em dinheiro x quanto foi contado.
      addColumn(db, 'cashier_sessions', 'expected_cash', 'REAL');
      addColumn(db, 'cashier_sessions', 'counted_cash', 'REAL');
      addColumn(db, 'cashier_sessions', 'cash_difference', 'REAL');
      addColumn(db, 'cashier_sessions', 'closing_note', 'TEXT');

      // Sangria (retirada) e suprimento (reforço de troco) da gaveta.
      db.exec(`
        CREATE TABLE IF NOT EXISTS cash_movements (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          type TEXT NOT NULL CHECK(type IN ('SANGRIA', 'SUPRIMENTO')),
          amount REAL NOT NULL CHECK(amount > 0),
          reason TEXT NOT NULL,
          user_id TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
          FOREIGN KEY (session_id) REFERENCES cashier_sessions(id),
          FOREIGN KEY (user_id) REFERENCES users(id)
        );
        CREATE INDEX IF NOT EXISTS idx_cash_mov_session ON cash_movements(session_id);
      `);
    }
  },
  {
    version: 4,
    name: 'modulo-fiscal-nfce',
    up: db => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS fiscal_settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
        );

        CREATE TABLE IF NOT EXISTS fiscal_sequence (
          serie INTEGER PRIMARY KEY,
          ultimo_numero INTEGER NOT NULL DEFAULT 0
        );

        -- Uma NFC-e por fechamento de conta. O payload guarda o retrato da venda
        -- (itens, pagamentos, emitente) para reenviar igualzinho depois.
        CREATE TABLE IF NOT EXISTS fiscal_documents (
          id TEXT PRIMARY KEY,
          checkout_id TEXT NOT NULL UNIQUE,
          table_id TEXT,
          table_number INTEGER,
          provider TEXT NOT NULL,
          ambiente INTEGER NOT NULL,
          serie INTEGER NOT NULL,
          numero INTEGER NOT NULL,
          chave TEXT UNIQUE,
          status TEXT NOT NULL DEFAULT 'PENDENTE'
            CHECK(status IN ('PENDENTE', 'AUTORIZADO', 'CONTINGENCIA', 'REJEITADO', 'CANCELADO', 'ERRO')),
          tp_emis INTEGER NOT NULL DEFAULT 1,
          valor_total REAL NOT NULL,
          payload_json TEXT NOT NULL,
          protocolo TEXT,
          motivo TEXT,
          xml_path TEXT,
          qr_code_url TEXT,
          tentativas INTEGER NOT NULL DEFAULT 0,
          proxima_tentativa TEXT,
          contingencia_desde TEXT,
          autorizado_em TEXT,
          cancelado_em TEXT,
          cancel_protocolo TEXT,
          cancel_justificativa TEXT,
          created_by TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
          UNIQUE (serie, numero, ambiente)
        );
        CREATE INDEX IF NOT EXISTS idx_fiscal_docs_status ON fiscal_documents(status);
        CREATE INDEX IF NOT EXISTS idx_fiscal_docs_created ON fiscal_documents(created_at);
      `);

      // Dados fiscais por produto. Sem valor padrão de propósito: produto sem
      // NCM bloqueia a emissão em vez de sair com um NCM "chutado".
      for (const [col, def] of [
        ['ncm', 'TEXT'], ['cfop', 'TEXT'], ['cest', 'TEXT'], ['origem', 'TEXT'],
        ['csosn', 'TEXT'], ['cst_icms', 'TEXT'], ['cst_pis_cofins', 'TEXT'], ['unidade_fiscal', 'TEXT'], ['gtin', 'TEXT']
      ] as const) {
        addColumn(db, 'menu_items', col, def);
      }
    }
  },
  {
    version: 5,
    name: 'licenca',
    up: db => {
      // Uma linha só: a licença desta instalação e o controle anti-relógio-atrasado.
      db.exec(`
        CREATE TABLE IF NOT EXISTS license_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          token TEXT,
          client_id TEXT,
          server_url TEXT,
          trial_started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          last_seen_ms INTEGER NOT NULL DEFAULT 0,
          last_refresh_at TEXT,
          last_refresh_error TEXT,
          updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
        );
        INSERT OR IGNORE INTO license_state (id) VALUES (1);
      `);
    }
  }
];

export function getSchemaVersion(db: Database): number {
  return Number(db.pragma('user_version', { simple: true }));
}

export function pendingMigrations(db: Database): Migration[] {
  const current = getSchemaVersion(db);
  return MIGRATIONS.filter(m => m.version > current);
}

export function runMigrations(db: Database): void {
  const pending = pendingMigrations(db);
  const hasData = (db.prepare('SELECT COUNT(*) as c FROM orders').get() as { c: number }).c > 0
    || (db.prepare('SELECT COUNT(*) as c FROM users').get() as { c: number }).c > 0;

  // Banco com dados: cópia de segurança antes de mexer no esquema.
  if (pending.length > 0 && hasData) {
    const file = backupSync(db, `pre-migracao-v${getSchemaVersion(db)}-para-v${pending.at(-1)!.version}`);
    console.log(`💾 Backup antes da migração salvo em ${file}`);
  }

  for (const migration of pending) {
    db.transaction(() => {
      migration.up(db);
      db.pragma(`user_version = ${migration.version}`);
    })();
    console.log(`🗄️  Migração ${migration.version} aplicada: ${migration.name}`);
  }
}
