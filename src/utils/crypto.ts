import { scrypt, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';
import { promisify } from 'node:util';
import { JWT_SECRET } from '../config/secrets.js';
import type { UserRole } from '../models/types.js';

const scryptAsync = promisify(scrypt) as (password: string, salt: string, keylen: number) => Promise<Buffer>;

export interface TokenPayload {
  userId: string;
  name: string;
  role: UserRole;
  /** Versão do token do usuário: muda ao trocar senha, papel ou desativar. */
  tv: number;
  /** Troca de senha obrigatória: o token só serve para trocar a senha. */
  mcp?: boolean;
  exp: number;
}

/** 12 horas: cobre um expediente inteiro sem deixar sessões esquecidas por dias. */
export const TOKEN_TTL_SECONDS = 12 * 60 * 60;

const HEADER = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');

/**
 * scrypt assíncrono: a versão síncrona bloqueava o servidor inteiro a cada
 * tentativa de login, e uma rajada de logins travava o salão.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const derived = await scryptAsync(password, salt, 64);
  return `${salt}:${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const [salt, key] = storedHash.split(':');
  if (!salt || !key) return false;
  const keyBuffer = Buffer.from(key, 'hex');
  const derived = await scryptAsync(password, salt, 64);
  return keyBuffer.length === derived.length && timingSafeEqual(keyBuffer, derived);
}

function sign(data: string): string {
  return createHmac('sha256', JWT_SECRET).update(data).digest('base64url');
}

export function generateToken(payload: Omit<TokenPayload, 'exp'>, expiresInSeconds: number = TOKEN_TTL_SECONDS): string {
  const fullPayload: TokenPayload = {
    ...payload,
    exp: Math.floor(Date.now() / 1000) + expiresInSeconds
  };
  const body = Buffer.from(JSON.stringify(fullPayload)).toString('base64url');
  return `${HEADER}.${body}.${sign(`${HEADER}.${body}`)}`;
}

export function verifyToken(token: string): TokenPayload | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, body, signature] = parts;
    if (!header || !body || !signature) return null;

    // Só aceitamos o cabeçalho que nós mesmos emitimos (bloqueia alg=none e afins).
    if (header !== HEADER) return null;

    const expected = Buffer.from(sign(`${header}.${body}`));
    const received = Buffer.from(signature);
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
      return null;
    }

    const payload: TokenPayload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}
