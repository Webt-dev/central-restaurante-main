import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { env } from './config/env.js';
import { initDatabase } from './config/database.js';
import { getDocumentsRootDir } from './utils/documentPaths.js';

const db = new Database(env.DB_PATH);

db.pragma('foreign_keys = OFF');

db.exec('DELETE FROM order_items;');
db.exec('DELETE FROM payments;');
db.exec('DELETE FROM orders;');
db.exec('DELETE FROM cashier_sessions;');
db.exec('DELETE FROM menu_item_ingredients;');
db.exec('DELETE FROM menu_items;');
db.exec('DELETE FROM inventory;');

db.exec("UPDATE tables SET status = 'FREE', updated_at = datetime('now', 'localtime');");

db.pragma('foreign_keys = ON');

// Inicializar tabelas e repopular cardápio rico e estoque expandido
initDatabase();

console.log('✅ BANCO DE DADOS ZERADO E CARDÁPIO COMPLETO REPOPULADO!');
console.log('📊 Faturamento: R$ 0.00 | Pedidos encerrados: 0 | Mesas: Todas LIVRES.');

const rootDir = getDocumentsRootDir();
const receiptsDir = path.join(rootDir, 'comprovantes_mesas');
const reportsDir = path.join(rootDir, 'relatorios_expediente');

function removeDirRecursive(targetPath: string) {
  if (fs.existsSync(targetPath)) {
    fs.readdirSync(targetPath).forEach(file => {
      const curPath = path.join(targetPath, file);
      if (fs.lstatSync(curPath).isDirectory()) {
        removeDirRecursive(curPath);
        fs.rmdirSync(curPath);
      } else {
        fs.unlinkSync(curPath);
      }
    });
  }
}

removeDirRecursive(receiptsDir);
removeDirRecursive(reportsDir);

console.log(`📄 Arquivos e pastas na Área de Trabalho (${rootDir}) limpos com sucesso!`);
