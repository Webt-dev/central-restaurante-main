import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { env } from './env.js';

/**
 * Segredo que assina os tokens de login.
 *
 * Antes havia um valor padrão escrito no código, igual em todas as
 * instalações: qualquer pessoa com acesso ao repositório conseguia forjar um
 * token de ADMIN. Agora cada instalação gera o próprio segredo aleatório no
 * primeiro boot e o guarda na pasta de dados, fora do banco e do git.
 * JWT_SECRET no ambiente continua tendo prioridade (útil em testes).
 */
const SECRET_FILE = path.join(env.DATA_DIR, '.jwt-secret');
const MIN_LENGTH = 32;

function loadOrCreateSecret(): string {
  const fromEnv = process.env.JWT_SECRET;
  if (fromEnv) {
    if (fromEnv.length < MIN_LENGTH) {
      throw new Error(`JWT_SECRET deve ter pelo menos ${MIN_LENGTH} caracteres.`);
    }
    return fromEnv;
  }

  if (fs.existsSync(SECRET_FILE)) {
    const stored = fs.readFileSync(SECRET_FILE, 'utf8').trim();
    if (stored.length >= MIN_LENGTH) return stored;
  }

  const generated = randomBytes(48).toString('base64url');
  fs.mkdirSync(env.DATA_DIR, { recursive: true });
  fs.writeFileSync(SECRET_FILE, generated, { encoding: 'utf8', mode: 0o600 });
  console.log('🔐 Segredo de autenticação gerado para esta instalação.');
  return generated;
}

export const JWT_SECRET = loadOrCreateSecret();
