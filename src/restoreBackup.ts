import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { env } from './config/env.js';
import { BACKUP_DIR, listBackups } from './services/BackupService.js';

/**
 * Restaura um backup.  Uso (com o sistema FECHADO):
 *   npm run restore            -> lista os backups disponíveis
 *   npm run restore -- <arquivo>
 *
 * O banco atual não é apagado: é renomeado para "<banco>.antes-da-restauracao-<data>".
 */
const fileArg = process.argv[2];

if (!fileArg) {
  console.log(`Backups em ${BACKUP_DIR}:`);
  for (const b of listBackups()) {
    console.log(`  ${b.file}  (${(b.size / 1024).toFixed(0)} KB, ${b.created_at})`);
  }
  console.log('\nPara restaurar: npm run restore -- <arquivo>');
  process.exit(0);
}

const source = path.isAbsolute(fileArg) ? fileArg : path.join(BACKUP_DIR, fileArg);
if (!fs.existsSync(source)) {
  console.error(`Arquivo não encontrado: ${source}`);
  process.exit(1);
}

const check = new Database(source, { readonly: true });
const integrity = check.pragma('integrity_check', { simple: true });
check.close();
if (integrity !== 'ok') {
  console.error(`O backup está corrompido (${integrity}). Escolha outro arquivo.`);
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
for (const suffix of ['', '-wal', '-shm']) {
  const current = `${env.DB_PATH}${suffix}`;
  if (fs.existsSync(current)) fs.renameSync(current, `${current}.antes-da-restauracao-${stamp}`);
}
fs.copyFileSync(source, env.DB_PATH);
console.log(`✅ Banco restaurado a partir de ${path.basename(source)}. Já pode abrir o sistema.`);
