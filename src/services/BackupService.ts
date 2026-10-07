import fs from 'node:fs';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import { env } from '../config/env.js';

/**
 * Backup do banco SQLite.
 *
 * - Diário: no boot (se ainda não houver o do dia) e a cada 6 horas.
 * - Rotação: últimos 7 diários + 4 semanais (o de domingo vira semanal).
 * - Antes de cada migração: cópia "pre-migracao-vN".
 * - BACKUP_MIRROR_DIR (opcional): uma segunda cópia em outra pasta/disco
 *   (pendrive, pasta sincronizada com a nuvem).
 *
 * Copiar só o arquivo .sqlite com o WAL ativo gera backup corrompido; por
 * isso usamos a API de backup do SQLite / VACUUM INTO.
 */
export const BACKUP_DIR = path.join(env.DATA_DIR, 'backups');
const KEEP_DAILY = 7;
const KEEP_WEEKLY = 4;
const SIX_HOURS = 6 * 60 * 60 * 1000;

export interface BackupInfo {
  file: string;
  kind: 'daily' | 'weekly' | 'manual' | 'pre-migration';
  size: number;
  created_at: string;
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function mirror(file: string): void {
  const mirrorDir = process.env.BACKUP_MIRROR_DIR;
  if (!mirrorDir) return;
  try {
    ensureDir(mirrorDir);
    fs.copyFileSync(file, path.join(mirrorDir, path.basename(file)));
  } catch (err) {
    console.warn('⚠️ Não foi possível copiar o backup para BACKUP_MIRROR_DIR:', (err as Error).message);
  }
}

/** Cópia síncrona e consistente (usada antes de migrar o esquema). */
export function backupSync(db: Database, name: string): string {
  ensureDir(BACKUP_DIR);
  const target = path.join(BACKUP_DIR, `${name}.sqlite`);
  if (fs.existsSync(target)) fs.unlinkSync(target);
  db.prepare('VACUUM INTO ?').run(target);
  mirror(target);
  return target;
}

export async function createBackup(db: Database, kind: 'daily' | 'manual' = 'manual'): Promise<string> {
  ensureDir(BACKUP_DIR);
  const stamp = kind === 'daily' ? today() : new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(BACKUP_DIR, `${kind}-${stamp}.sqlite`);
  await db.backup(target);
  mirror(target);
  return target;
}

function rotate(): void {
  const files = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('daily-')).sort();
  for (const f of files.slice(0, Math.max(0, files.length - KEEP_DAILY))) {
    const date = new Date(`${f.slice(6, 16)}T12:00:00`);
    const weeklyName = `weekly-${f.slice(6, 16)}.sqlite`;
    // O backup de domingo é promovido a semanal antes de sair da janela diária.
    if (date.getDay() === 0 && !fs.existsSync(path.join(BACKUP_DIR, weeklyName))) {
      fs.renameSync(path.join(BACKUP_DIR, f), path.join(BACKUP_DIR, weeklyName));
    } else {
      fs.unlinkSync(path.join(BACKUP_DIR, f));
    }
  }
  const weekly = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('weekly-')).sort();
  for (const f of weekly.slice(0, Math.max(0, weekly.length - KEEP_WEEKLY))) {
    fs.unlinkSync(path.join(BACKUP_DIR, f));
  }
}

export async function runDailyBackup(db: Database): Promise<void> {
  try {
    ensureDir(BACKUP_DIR);
    if (!fs.existsSync(path.join(BACKUP_DIR, `daily-${today()}.sqlite`))) {
      const file = await createBackup(db, 'daily');
      console.log(`💾 Backup diário salvo em ${file}`);
    }
    rotate();
  } catch (err) {
    console.error('❌ Falha no backup automático:', (err as Error).message);
  }
}

export function scheduleBackups(db: Database): void {
  void runDailyBackup(db);
  setInterval(() => void runDailyBackup(db), SIX_HOURS).unref();
}

export function listBackups(): BackupInfo[] {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR)
    .filter(f => f.endsWith('.sqlite'))
    .map(f => {
      const stat = fs.statSync(path.join(BACKUP_DIR, f));
      const kind: BackupInfo['kind'] = f.startsWith('daily-') ? 'daily'
        : f.startsWith('weekly-') ? 'weekly'
        : f.startsWith('pre-migracao') ? 'pre-migration'
        : 'manual';
      return { file: f, kind, size: stat.size, created_at: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/** Verificação rápida de integridade no boot. */
export function checkIntegrity(db: Database): boolean {
  const result = db.pragma('quick_check', { simple: true });
  if (result !== 'ok') {
    console.error(`❌ O banco de dados apresenta problemas de integridade: ${result}. Restaure um backup de ${BACKUP_DIR}.`);
    return false;
  }
  return true;
}
