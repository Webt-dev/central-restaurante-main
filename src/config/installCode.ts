import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { env } from './env.js';

/**
 * Código de instalação.
 *
 * O primeiro ADMIN é criado por uma rota pública (POST /api/auth/setup). Sem
 * proteção, qualquer aparelho que alcançasse o servidor na rede antes do dono
 * (ou depois de uma reinstalação) viraria administrador. Por isso o servidor
 * gera um código aleatório no primeiro boot, grava na pasta de dados e mostra
 * no console/log; só quem tem acesso ao computador do estabelecimento o vê.
 * Depois que o ADMIN é criado o arquivo é apagado.
 */
const CODE_FILE = path.join(env.DATA_DIR, '.install-code');
// Sem 0/O/1/I/L para o dono não errar ao digitar.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function generate(): string {
  const part = () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  return `${part()}-${part()}-${part()}`;
}

/** Ignora maiúsculas, traços e espaços para o usuário não tropeçar na digitação. */
function normalize(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Devolve o código vigente (cria se não existir). INSTALL_CODE no ambiente tem prioridade (automação/testes). */
export function getInstallCode(): string {
  const fromEnv = process.env.INSTALL_CODE;
  if (fromEnv && normalize(fromEnv).length >= 8) return fromEnv;

  if (fs.existsSync(CODE_FILE)) {
    const stored = fs.readFileSync(CODE_FILE, 'utf8').trim();
    if (normalize(stored).length >= 8) return stored;
  }
  const code = generate();
  fs.mkdirSync(env.DATA_DIR, { recursive: true });
  fs.writeFileSync(CODE_FILE, code, { encoding: 'utf8', mode: 0o600 });
  return code;
}

export function installCodeFile(): string {
  return CODE_FILE;
}

/** Apaga o código depois que o sistema foi configurado. */
export function discardInstallCode(): void {
  try {
    fs.rmSync(CODE_FILE, { force: true });
  } catch {
    // não é crítico: a rota já recusa quando existe ADMIN
  }
}

// Comparação por hash + timingSafeEqual: tempo constante, não vaza quantos caracteres batem.
function sameCode(a: string, b: string): boolean {
  const ha = createHash('sha256').update(normalize(a)).digest();
  const hb = createHash('sha256').update(normalize(b)).digest();
  return timingSafeEqual(ha, hb);
}

// Freio contra tentativa e erro: 10 erros por IP e a rota fecha por 15 minutos.
const MAX_FAILS = 10;
const LOCK_MS = 15 * 60_000;
const fails = new Map<string, { count: number; until: number }>();

export type InstallCodeResult = 'ok' | 'invalid' | 'locked';

export function checkInstallCode(provided: string | undefined, ip: string): InstallCodeResult {
  const now = Date.now();
  let entry = fails.get(ip);
  if (entry && entry.until > now) return 'locked';
  if (entry && entry.until > 0) entry = undefined; // bloqueio expirou: recomeça a contagem

  if (provided && sameCode(provided, getInstallCode())) {
    fails.delete(ip);
    return 'ok';
  }
  const count = (entry?.count ?? 0) + 1;
  fails.set(ip, { count, until: count >= MAX_FAILS ? now + LOCK_MS : 0 });
  return count >= MAX_FAILS ? 'locked' : 'invalid';
}

export function resetInstallCodeThrottle(): void {
  fails.clear();
}
