import fs from 'node:fs';
import path from 'node:path';
import { format } from 'node:util';
import { env } from '../config/env.js';
import { maskPii } from './pii.js';

/**
 * Log em arquivo, sem dependências.
 *
 * Tudo que o servidor escreve no console também vai para
 * <pasta de dados>/logs/central-AAAA-MM-DD.log (um arquivo por dia, 14 dias
 * guardados). Sem isso, no Electron os logs simplesmente sumiam e não havia
 * como investigar um problema relatado pelo cliente.
 *
 * Importe este módulo antes de qualquer outro no ponto de entrada.
 */
export const LOG_DIR = path.join(env.DATA_DIR, 'logs');
const KEEP_DAYS = 14;

// Remove códigos de cor e mascara tokens/senhas que eventualmente apareçam.
const ANSI = /\x1b\[[0-9;]*m/g;
const SECRETS = /(Bearer\s+)[\w.-]+|("?(?:password|senha|pin|token|csc)"?\s*[:=]\s*)"?[^",\s}]+"?/gi;

// Além de segredos, CPF e e-mail (dados pessoais - LGPD) nunca vão inteiros para o arquivo de log.
export function sanitize(line: string): string {
  const semSegredos = line.replace(ANSI, '').replace(SECRETS, (_m, bearer, key) => (bearer ? `${bearer}***` : `${key}***`));
  return maskPii(semSegredos);
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

let currentDay = '';
let stream: fs.WriteStream | null = null;

function getStream(): fs.WriteStream | null {
  const day = today();
  if (stream && day === currentDay) return stream;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    stream?.end();
    stream = fs.createWriteStream(path.join(LOG_DIR, `central-${day}.log`), { flags: 'a' });
    currentDay = day;
    pruneOldLogs();
  } catch {
    stream = null;
  }
  return stream;
}

function pruneOldLogs(): void {
  const limit = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
  for (const file of fs.readdirSync(LOG_DIR)) {
    const full = path.join(LOG_DIR, file);
    try {
      if (file.startsWith('central-') && fs.statSync(full).mtimeMs < limit) fs.unlinkSync(full);
    } catch {
      // arquivo em uso: tenta no próximo dia
    }
  }
}

function write(level: string, args: unknown[]): void {
  const out = getStream();
  if (!out) return;
  const message = sanitize(format(...args));
  out.write(`${new Date().toISOString()} [${level}] ${message}\n`);
}

if (process.env.NODE_ENV !== 'test') {
  for (const [method, level] of [['log', 'INFO'], ['info', 'INFO'], ['warn', 'WARN'], ['error', 'ERROR']] as const) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      original(...args);
      write(level, args);
    };
  }

  process.on('uncaughtException', err => {
    write('FATAL', [err]);
  });
  process.on('unhandledRejection', reason => {
    write('ERROR', ['Promise rejeitada sem tratamento:', reason]);
  });
}
