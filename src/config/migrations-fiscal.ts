import { db } from './database.js';

/**
 * Cria as tabelas e colunas do módulo fiscal (NFC-e).
 *
 * Chame esta função dentro de initDatabase(), logo antes de seedDefaultData().
 * É segura para rodar várias vezes.
 */
export function initFiscalSchema(): void {
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

    CREATE TABLE IF NOT EXISTS fiscal_documents (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      table_number INTEGER,
      numero INTEGER NOT NULL,
      serie INTEGER NOT NULL,
      modelo TEXT NOT NULL DEFAULT '65',
      chave_acesso TEXT,
      status TEXT NOT NULL DEFAULT 'PENDENTE'
        CHECK(status IN ('PENDENTE','GERADO','AUTORIZADO','REJEITADO','CANCELADO')),
      ambiente INTEGER NOT NULL DEFAULT 2,
      valor_total REAL NOT NULL DEFAULT 0,
      cpf_consumidor TEXT,
      xml_path TEXT,
      qr_code TEXT,
      protocolo TEXT,
      motivo_rejeicao TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );

    CREATE INDEX IF NOT EXISTS idx_fiscal_docs_order ON fiscal_documents(order_id);
    CREATE INDEX IF NOT EXISTS idx_fiscal_docs_status ON fiscal_documents(status);
    CREATE INDEX IF NOT EXISTS idx_fiscal_docs_data ON fiscal_documents(created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_fiscal_docs_chave
      ON fiscal_documents(chave_acesso) WHERE chave_acesso IS NOT NULL;
  `);

  // Campos fiscais nos produtos do cardápio.
  const colunasFiscais: { nome: string; definicao: string; padrao: string }[] = [
    { nome: 'ncm', definicao: "TEXT DEFAULT '21069090'", padrao: '21069090' },
    { nome: 'cfop', definicao: "TEXT DEFAULT '5102'", padrao: '5102' },
    { nome: 'cest', definicao: 'TEXT', padrao: '' },
    { nome: 'origem', definicao: "TEXT DEFAULT '0'", padrao: '0' },
    { nome: 'csosn', definicao: "TEXT DEFAULT '102'", padrao: '102' },
    { nome: 'cst_icms', definicao: "TEXT DEFAULT '60'", padrao: '60' },
    { nome: 'unidade_fiscal', definicao: "TEXT DEFAULT 'UN'", padrao: 'UN' }
  ];

  try {
    const info = db.prepare('PRAGMA table_info(menu_items)').all() as { name: string }[];
    const existentes = new Set(info.map(c => c.name));

    for (const col of colunasFiscais) {
      if (!existentes.has(col.nome)) {
        db.exec(`ALTER TABLE menu_items ADD COLUMN ${col.nome} ${col.definicao};`);
      }
    }
  } catch (err) {
    console.warn('Aviso ao criar colunas fiscais em menu_items:', err);
  }

  // NCM sugerido por categoria — o contador deve revisar antes de emitir.
  try {
    const sugestoes: { padraoCategoria: string; ncm: string }[] = [
      { padraoCategoria: '%Bebida%', ncm: '22029900' },
      { padraoCategoria: '%Drink%', ncm: '22089000' },
      { padraoCategoria: '%Sobremesa%', ncm: '19059090' },
      { padraoCategoria: '%Lanche%', ncm: '21069090' },
      { padraoCategoria: '%Porç%', ncm: '21069090' },
      { padraoCategoria: '%Prato%', ncm: '21069090' }
    ];

    const upd = db.prepare(`
      UPDATE menu_items SET ncm = ?
      WHERE category LIKE ? AND (ncm IS NULL OR ncm = '' OR ncm = '21069090')
    `);

    for (const s of sugestoes) {
      upd.run(s.ncm, s.padraoCategoria);
    }
  } catch (err) {
    console.warn('Aviso ao sugerir NCM por categoria:', err);
  }

  console.log('✅ Módulo fiscal inicializado (NFC-e modelo 65).');
}
