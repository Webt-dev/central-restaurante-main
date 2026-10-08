import Database, { type Database as SqliteDatabase } from 'better-sqlite3';
import { env } from './env.js';
import { runMigrations } from './migrations.js';
import { checkIntegrity } from '../services/BackupService.js';
import path from 'node:path';
import fs from 'node:fs';

const dbDir = path.dirname(env.DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

export const db: SqliteDatabase = new Database(env.DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
// Com WAL, synchronous=NORMAL é seguro contra corrupção (só pode perder a última
// transação num corte de energia) e bem mais rápido que FULL.
db.pragma('synchronous = NORMAL');
// Em vez de falhar na hora com SQLITE_BUSY (backup/worker concorrente), espera até 5 s.
db.pragma('busy_timeout = 5000');
// Cache de páginas de ~16 MB (valor negativo = KiB) e temporários em memória.
db.pragma('cache_size = -16000');
db.pragma('temp_store = MEMORY');

export function initDatabase(): void {
  checkIntegrity(db);

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      username TEXT UNIQUE NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('ADMIN', 'CASHIER', 'WAITER', 'KITCHEN')),
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS inventory (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      unit TEXT NOT NULL,
      quantity REAL NOT NULL DEFAULT 0,
      min_quantity REAL NOT NULL DEFAULT 0,
      unit_price REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS menu_items (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      price REAL NOT NULL,
      category TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS menu_item_ingredients (
      id TEXT PRIMARY KEY,
      menu_item_id TEXT NOT NULL,
      inventory_id TEXT NOT NULL,
      quantity_required REAL NOT NULL,
      FOREIGN KEY (menu_item_id) REFERENCES menu_items(id) ON DELETE CASCADE,
      FOREIGN KEY (inventory_id) REFERENCES inventory(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS tables (
      id TEXT PRIMARY KEY,
      number INTEGER UNIQUE NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'FREE' CHECK(status IN ('FREE', 'OCCUPIED', 'PAYMENT_PENDING')),
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      table_id TEXT NOT NULL,
      waiter_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN', 'PREPARING', 'READY', 'DELIVERED', 'CLOSED', 'CANCELLED')),
      total_amount REAL NOT NULL DEFAULT 0,
      notes TEXT,
      offline_sync_id TEXT UNIQUE,
      cashier_session_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (table_id) REFERENCES tables(id),
      FOREIGN KEY (waiter_id) REFERENCES users(id),
      FOREIGN KEY (cashier_session_id) REFERENCES cashier_sessions(id)
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      menu_item_id TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      unit_price REAL NOT NULL,
      total_price REAL NOT NULL,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING', 'PREPARING', 'READY', 'DELIVERED', 'CANCELLED')),
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
      FOREIGN KEY (menu_item_id) REFERENCES menu_items(id)
    );

    CREATE TABLE IF NOT EXISTS cashier_sessions (
      id TEXT PRIMARY KEY,
      opened_by_id TEXT NOT NULL,
      closed_by_id TEXT,
      opened_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      closed_at TEXT,
      initial_balance REAL NOT NULL DEFAULT 0,
      final_balance REAL,
      total_sales REAL NOT NULL DEFAULT 0,
      total_cash REAL NOT NULL DEFAULT 0,
      total_card REAL NOT NULL DEFAULT 0,
      total_pix REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN', 'CLOSED')),
      FOREIGN KEY (opened_by_id) REFERENCES users(id),
      FOREIGN KEY (closed_by_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      table_id TEXT NOT NULL,
      order_id TEXT NOT NULL,
      cashier_session_id TEXT NOT NULL,
      payment_method TEXT NOT NULL CHECK(payment_method IN ('CASH', 'CREDIT_CARD', 'DEBIT_CARD', 'PIX')),
      amount REAL NOT NULL,
      amount_paid REAL NOT NULL,
      change_given REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (table_id) REFERENCES tables(id),
      FOREIGN KEY (order_id) REFERENCES orders(id),
      FOREIGN KEY (cashier_session_id) REFERENCES cashier_sessions(id)
    );

    CREATE TABLE IF NOT EXISTS restaurant_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );

    CREATE INDEX IF NOT EXISTS idx_orders_table ON orders(table_id);
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
    CREATE INDEX IF NOT EXISTS idx_payments_session ON payments(cashier_session_id);
  `);

  try {
    const tableInfo = db.prepare("PRAGMA table_info(orders)").all() as { name: string }[];
    const hasCashierSessionId = tableInfo.some(col => col.name === 'cashier_session_id');
    if (!hasCashierSessionId) {
      db.exec("ALTER TABLE orders ADD COLUMN cashier_session_id TEXT;");
    }
    db.exec("CREATE INDEX IF NOT EXISTS idx_orders_session ON orders(cashier_session_id);");
  } catch (migErr) {
    console.warn('Aviso na verificação de colunas da tabela orders:', migErr);
  }

  runMigrations(db);

  seedDefaultData();
  normalizeInventoryNames();
}

function seedDefaultData(): void {
  // Usuários: nenhum usuário padrão. O primeiro administrador é criado na
  // tela de configuração inicial (POST /api/auth/setup), com senha própria.

  // ------------------------------------------------------------------ Mesas
  const tableCount = (db.prepare('SELECT COUNT(*) as count FROM tables').get() as { count: number }).count;
  if (tableCount === 0) {
    const insertTable = db.prepare('INSERT INTO tables (id, number, name) VALUES (?, ?, ?)');
    for (let i = 1; i <= 10; i++) {
      insertTable.run(`t${i}`, i, `Mesa ${i}`);
    }
    console.log('✅ 10 mesas iniciais criadas.');
  }

  // Cardápio e estoque de demonstração: só no primeiro boot. Depois disso o
  // catálogo é do cliente e o seed nunca mais toca nele (antes o INSERT OR
  // REPLACE a cada boot devolvia preços e fichas técnicas ao valor de fábrica).
  const menuCount = (db.prepare('SELECT COUNT(*) as count FROM menu_items').get() as { count: number }).count;
  const inventoryCount = (db.prepare('SELECT COUNT(*) as count FROM inventory').get() as { count: number }).count;
  if (menuCount > 0 || inventoryCount > 0) return;

  db.transaction(seedDemoCatalog)();
}

function seedDemoCatalog(): void {
  // ---------------------------------------------------------------- Estoque
  const insertInv = db.prepare(
    'INSERT OR IGNORE INTO inventory (id, name, unit, quantity, min_quantity, unit_price) VALUES (?, ?, ?, ?, ?, ?)'
  );

  const paoBrioche = 'inv-pao';
  const carne180g = 'inv-carne';
  const carneSmash90g = 'inv-carne-smash';
  const queijoCheddar = 'inv-queijo';
  const baconFatiado = 'inv-bacon';
  const batataInNatura = 'inv-batata';
  const refriCola = 'inv-refri-cola';
  const refriGuarana = 'inv-refri-guarana';
  const sucoLaranja = 'inv-laranja';
  const sorveteCreme = 'inv-sorvete';
  const picanhaBovina = 'inv-picanha';
  const filetMignon = 'inv-mignon';
  const peitoFrango = 'inv-frango';
  const peixeFile = 'inv-peixe';
  const costelaBovina = 'inv-costela';
  const limaoTahiti = 'inv-limao';
  const ginGarrafa = 'inv-gin';
  const cachacaGarrafa = 'inv-cachaca';
  const aperolGarrafa = 'inv-aperol';
  const brownieBolo = 'inv-brownie';

  // Nomes sem sufixo de unidade: a unidade já aparece na coluna própria.
  insertInv.run(paoBrioche, 'Pão de Hambúrguer Brioche', 'un', 150, 30, 1.80);
  insertInv.run(carne180g, 'Hambúrguer Artesanal 180g', 'un', 80, 15, 8.50);
  insertInv.run(carneSmash90g, 'Carne Smash', 'g', 15000, 2000, 0.04);
  insertInv.run(queijoCheddar, 'Queijo Cheddar Fatiado', 'un', 300, 40, 0.90);
  insertInv.run(baconFatiado, 'Bacon Defumado Fatiado', 'g', 5000, 1000, 0.06);
  insertInv.run(batataInNatura, 'Batata para Porção', 'g', 20000, 3000, 0.02);
  insertInv.run(refriCola, 'Lata Refrigerante Cola 350ml', 'un', 150, 30, 3.50);
  insertInv.run(refriGuarana, 'Lata Refrigerante Guaraná 350ml', 'un', 120, 24, 3.50);
  insertInv.run(sucoLaranja, 'Laranja in Natura', 'un', 200, 40, 1.00);
  insertInv.run(sorveteCreme, 'Sorvete de Creme', 'g', 10000, 1500, 0.04);
  insertInv.run(picanhaBovina, 'Picanha Bovina', 'g', 15000, 2500, 0.12);
  insertInv.run(filetMignon, 'Filé Mignon Bovino', 'g', 12000, 2000, 0.10);
  insertInv.run(peitoFrango, 'Peito de Frango', 'g', 18000, 3000, 0.03);
  insertInv.run(peixeFile, 'Filé de Peixe', 'g', 10000, 1500, 0.07);
  insertInv.run(costelaBovina, 'Costela Bovina Desfiada', 'g', 8000, 1000, 0.08);
  insertInv.run(limaoTahiti, 'Limão Tahiti', 'un', 250, 50, 0.60);
  insertInv.run(ginGarrafa, 'Gin', 'dose', 100, 20, 3.50);
  insertInv.run(cachacaGarrafa, 'Cachaça Artesanal', 'dose', 100, 20, 2.50);
  insertInv.run(aperolGarrafa, 'Aperol', 'dose', 80, 15, 4.00);
  insertInv.run(brownieBolo, 'Brownie de Chocolate', 'un', 50, 10, 5.00);

  // --------------------------------------------------------------- Cardápio
  const insertMenu = db.prepare(
    'INSERT OR IGNORE INTO menu_items (id, name, description, price, category, active) VALUES (?, ?, ?, ?, ?, 1)'
  );

  insertMenu.run('m1', 'X-Burguer Especial', 'Pão brioche, artesanal 180g, duplo cheddar', 32.90, 'Lanches');
  insertMenu.run('m2', 'Smash Bacon Supreme', 'Dois smash 90g (180g total), cheddar, bacon crocante', 36.50, 'Lanches');
  insertMenu.run('m7', 'Monster Cheddar Bacon', 'Três smash 90g (270g carne), triplo cheddar, bacon', 42.00, 'Lanches');
  insertMenu.run('m8', 'Chicken Crispy Mayo', 'Sobrecoxa empanada super crocante e maionese da casa', 29.90, 'Lanches');
  insertMenu.run('m9', 'X-Salada Artesanal', 'Pão brioche, artesanal 180g, queijo prato, alface e tomate', 31.00, 'Lanches');
  insertMenu.run('m25', 'Veggie Burger Cogumelos', 'Hambúrguer de cogumelos, queijo de cabra e rúcula', 34.00, 'Lanches');

  insertMenu.run('m10', 'Picanha na Grelha 500g', 'Acompanha arroz, farofa artesanal e vinagrete', 89.90, 'Pratos Principais');
  insertMenu.run('m11', 'Parmegiana de Mignon', 'Filé mignon empanado, molho de tomate e mussarela', 58.00, 'Pratos Principais');
  insertMenu.run('m12', 'Filé de Frango Grelhado', 'Servido com legumes na manteiga e purê de batata', 34.90, 'Pratos Principais');
  insertMenu.run('m26', 'Strogonoff de Filé Mignon', 'Com molho cremoso de cogumelos, batata palha e arroz', 46.00, 'Pratos Principais');
  insertMenu.run('m27', 'Feijoada Completa Individual', 'Acompanha couve refogada, torresmo, farofa e laranja', 49.90, 'Pratos Principais');
  insertMenu.run('m28', 'Bife de Ancho c/ Alho Assado', 'Corte nobre 350g com batatas rústicas e chimichurri', 69.00, 'Pratos Principais');

  insertMenu.run('m3', 'Batata Rústica c/ Páprica', 'Porção 400g servida com maionese da casa', 22.00, 'Porções');
  insertMenu.run('m13', 'Anéis de Cebola Empanados 300g', 'Anéis de cebola crocantes com molho barbecue', 26.00, 'Porções');
  insertMenu.run('m14', 'Isca de Peixe c/ Molho Tártaro', 'Porção 400g de peixe empanado bem crocante', 48.00, 'Porções');
  insertMenu.run('m15', 'Coxinha de Costela (6un)', 'Coxinhas recheadas com costela desfiada e catupiry', 32.00, 'Porções');
  insertMenu.run('m29', 'Mandioca Frita c/ Bacon', 'Porção 400g de mandioca dourada e bacon em cubos', 25.00, 'Porções');
  insertMenu.run('m30', 'Calabresa Acebolada na Chapa', 'Servida com farofa e fatias de pão francês', 38.00, 'Porções');
  insertMenu.run('m31', 'Frango a Passarinho c/ Alho', 'Porção 500g de frango crocante com alho frito', 42.00, 'Porções');

  insertMenu.run('m4', 'Refrigerante Cola 350ml', 'Lata 350ml trincando de gelada', 7.50, 'Bebidas');
  insertMenu.run('m5', 'Suco Natural Laranja 500ml', 'Suco fresco espremido na hora', 11.00, 'Bebidas');
  insertMenu.run('m16', 'Refrigerante Guaraná 350ml', 'Lata 350ml trincando de gelada', 7.50, 'Bebidas');
  insertMenu.run('m17', 'Água Mineral c/ Gás 500ml', 'Garrafa 500ml bem gelada', 5.00, 'Bebidas');
  insertMenu.run('m18', 'Água Mineral Sem Gás 500ml', 'Garrafa 500ml bem gelada', 4.50, 'Bebidas');
  insertMenu.run('m32', 'Chá Gelado Laranja & Sálvia', 'Copo 500ml refrescante', 9.50, 'Bebidas');
  insertMenu.run('m33', 'Cerveja Long Neck 330ml', 'Garrafa 330ml bem gelada', 12.00, 'Bebidas');

  insertMenu.run('m19', 'Caipirinha de Limão Tradicional', 'Cachaça artesanal, limão fresquinho e açúcar', 22.00, 'Drinks do Bar');
  insertMenu.run('m20', 'Gin Tônica Tropical', 'Gin importado, tônica e xarope de maracujá', 28.00, 'Drinks do Bar');
  insertMenu.run('m21', 'Aperol Spritz', 'Aperol, espumante e fatia de laranja', 30.00, 'Drinks do Bar');
  insertMenu.run('m22', 'Mojito Cubano Tradicional', 'Rum branco, hortelã fresca, limão e água com gás', 25.00, 'Drinks do Bar');
  insertMenu.run('m34', 'Piña Colada Classic', 'Rum, leite de coco, suco de abacaxi e leite condensado', 27.00, 'Drinks do Bar');
  insertMenu.run('m35', 'Moscow Mule c/ Espuma', 'Vodka, suco de limão e espuma artesanal de gengibre', 32.00, 'Drinks do Bar');

  insertMenu.run('m6', 'Petit Gâteau Chocolate', 'Acompanha sorvete de creme e calda quente', 24.90, 'Sobremesas');
  insertMenu.run('m23', 'Brownie c/ Sorvete de Creme', 'Brownie aquecido com bola de sorvete de creme', 22.00, 'Sobremesas');
  insertMenu.run('m24', 'Pudim de Leite Condensado', 'Fatia generosa com calda cremosa de caramelo', 14.00, 'Sobremesas');
  insertMenu.run('m36', 'Torta Holandesa Fatia', 'Creme holandês leve com cobertura de ganache', 18.00, 'Sobremesas');
  insertMenu.run('m37', 'Churros c/ Doce de Leite (4un)', 'Churros crocantes recheados com doce de leite', 20.00, 'Sobremesas');

  // ---------------------------------------------------------- Ficha técnica
  const insertIng = db.prepare(
    'INSERT OR IGNORE INTO menu_item_ingredients (id, menu_item_id, inventory_id, quantity_required) VALUES (?, ?, ?, ?)'
  );

  insertIng.run('ing-m1-1', 'm1', paoBrioche, 1);
  insertIng.run('ing-m1-2', 'm1', carne180g, 1);
  insertIng.run('ing-m1-3', 'm1', queijoCheddar, 2);

  insertIng.run('ing-m2-1', 'm2', paoBrioche, 1);
  insertIng.run('ing-m2-2', 'm2', carneSmash90g, 180);
  insertIng.run('ing-m2-3', 'm2', queijoCheddar, 2);
  insertIng.run('ing-m2-4', 'm2', baconFatiado, 50);

  insertIng.run('ing-m7-1', 'm7', paoBrioche, 1);
  insertIng.run('ing-m7-2', 'm7', carneSmash90g, 270);
  insertIng.run('ing-m7-3', 'm7', queijoCheddar, 3);
  insertIng.run('ing-m7-4', 'm7', baconFatiado, 80);

  insertIng.run('ing-m10-1', 'm10', picanhaBovina, 500);
  insertIng.run('ing-m11-1', 'm11', filetMignon, 300);
  insertIng.run('ing-m12-1', 'm12', peitoFrango, 250);
  insertIng.run('ing-m3-1', 'm3', batataInNatura, 400);
  insertIng.run('ing-m14-1', 'm14', peixeFile, 400);
  insertIng.run('ing-m15-1', 'm15', costelaBovina, 200);

  insertIng.run('ing-m19-1', 'm19', cachacaGarrafa, 1);
  insertIng.run('ing-m19-2', 'm19', limaoTahiti, 1);
  insertIng.run('ing-m20-1', 'm20', ginGarrafa, 1);
  insertIng.run('ing-m21-1', 'm21', aperolGarrafa, 1);

  insertIng.run('ing-m6-1', 'm6', sorveteCreme, 100);
  insertIng.run('ing-m23-1', 'm23', brownieBolo, 1);
  insertIng.run('ing-m23-2', 'm23', sorveteCreme, 100);

  console.log('✅ Cardápio e estoque de demonstração criados (primeiro boot).');
}

/**
 * Remove sufixos de unidade dos nomes de insumos já gravados em bancos
 * antigos ("Bacon Defumado Fatiado (Grama)" -> "Bacon Defumado Fatiado").
 * A unidade já é exibida em coluna própria, então o sufixo só poluía a tela.
 */
function normalizeInventoryNames(): void {
  try {
    const items = db.prepare('SELECT id, name FROM inventory').all() as { id: string; name: string }[];
    const update = db.prepare('UPDATE inventory SET name = ? WHERE id = ?');
    const pattern = /\s*\((grama|gramas|g|unidade|unidades|un|dose\s*50ml|dose|ml|litro|litros|l|pacote|pct)\)\s*$/i;

    let changed = 0;
    for (const item of items) {
      const cleaned = item.name.replace(pattern, '').trim();
      if (cleaned && cleaned !== item.name) {
        update.run(cleaned, item.id);
        changed++;
      }
    }

    if (changed > 0) {
      console.log(`✅ ${changed} nome(s) de insumo padronizados.`);
    }
  } catch (err) {
    console.warn('Aviso ao padronizar nomes de insumos:', err);
  }
}
