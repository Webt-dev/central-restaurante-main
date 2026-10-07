import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Cada arquivo de teste roda em um processo próprio (node --test), com banco
 * e pasta de documentos temporários. Chame ANTES de importar qualquer módulo
 * de src/, porque o banco é aberto no import.
 */
export function useTempEnvironment(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'central-test-'));
  process.env.DB_PATH = path.join(dir, 'test.sqlite');
  process.env.DOCUMENTS_DIR = path.join(dir, 'docs');
  process.env.JWT_SECRET = 'segredo-de-teste-com-mais-de-trinta-e-dois-caracteres';
  process.env.NODE_ENV = 'test';
  return dir;
}
