import dotenv from 'dotenv';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

dotenv.config();

function resolveDatabasePath(): string {
  if (process.env.DB_PATH && process.env.DB_PATH !== 'database.sqlite') {
    return process.env.DB_PATH;
  }

  // Verifica se o diretório atual de trabalho é gravável (ex: C:\Program Files\ NÃO é gravável para usuários comuns)
  let isCwdWritable = true;
  try {
    const testFile = path.join(process.cwd(), '.write_test');
    fs.writeFileSync(testFile, 'test');
    fs.unlinkSync(testFile);
  } catch {
    isCwdWritable = false;
  }

  // Se o diretório atual não for gravável, salva o banco no diretório AppData/Roaming do usuário
  if (!isCwdWritable) {
    const appDataDir = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    const targetFolder = path.join(appDataDir, 'CentralRestaurante');
    if (!fs.existsSync(targetFolder)) {
      fs.mkdirSync(targetFolder, { recursive: true });
    }
    const targetDbPath = path.join(targetFolder, 'database.sqlite');
    console.log(`📌 Banco de Dados SQLite em modo Electron/Produção resolvido em: ${targetDbPath}`);
    return targetDbPath;
  }

  return path.join(process.cwd(), 'database.sqlite');
}

const DB_PATH = resolveDatabasePath();

export const env = {
  PORT: process.env.PORT || '3000',
  DB_PATH,
  // Pasta de dados da instalação (banco, segredo, backups).
  DATA_DIR: path.dirname(DB_PATH),
  NODE_ENV: process.env.NODE_ENV || 'development'
};
