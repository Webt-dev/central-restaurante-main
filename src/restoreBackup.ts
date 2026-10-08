import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { env } from './config/env.js';
import { BACKUP_DIR, listBackups } from './services/BackupService.js';
import { decryptFile, isEncryptedFile } from './services/BackupCrypto.js';

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

// Backup criptografado (.enc): decifra para um temporário ao lado do banco e restaura a partir dele.
let plainSource = source;
let tempPlain: string | null = null;
if (isEncryptedFile(source)) {
  tempPlain = `${env.DB_PATH}.restaurando-${Date.now()}.tmp`;
  try {
    decryptFile(source, tempPlain);
  } catch (err) {
    console.error(`❌ ${(err as Error).message}`);
    console.error('   Se usou BACKUP_PASSPHRASE ao criar o backup, defina a mesma variável antes de restaurar.');
    process.exit(1);
  }
  plainSource = tempPlain;
}

const check = new Database(plainSource, { readonly: true });
const integrity = check.pragma('integrity_check', { simple: true });
check.close();
if (integrity !== 'ok') {
  console.error(`O backup está corrompido (${integrity}). Escolha outro arquivo.`);
  if (tempPlain) fs.rmSync(tempPlain, { force: true });
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
for (const suffix of ['', '-wal', '-shm']) {
  const current = `${env.DB_PATH}${suffix}`;
  if (fs.existsSync(current)) fs.renameSync(current, `${current}.antes-da-restauracao-${stamp}`);
}
fs.copyFileSync(plainSource, env.DB_PATH);
if (tempPlain) fs.rmSync(tempPlain, { force: true });
console.log(`✅ Banco restaurado a partir de ${path.basename(source)}. Já pode abrir o sistema.`);
