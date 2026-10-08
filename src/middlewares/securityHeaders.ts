import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

/**
 * Cabeçalhos de segurança (sem dependência nova).
 *
 * A CSP é restritiva: só recursos da própria origem, mais o que o frontend
 * realmente usa - Google Fonts (CSS e arquivos de fonte), imagens data: e
 * WebSocket do Socket.IO. O index.html tem um script inline pequeno (aplica o
 * tema antes da primeira pintura); em vez de liberar 'unsafe-inline' para
 * scripts, calculamos o hash SHA-256 desse trecho no boot e liberamos só ele.
 * style-src mantém 'unsafe-inline' porque o React usa atributos style.
 */
export function inlineScriptHashes(indexHtmlPath: string | null): string[] {
  if (!indexHtmlPath || !fs.existsSync(indexHtmlPath)) return [];
  const html = fs.readFileSync(indexHtmlPath, 'utf8');
  const hashes: string[] = [];
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
    // O parser HTML do navegador troca CRLF por LF antes de calcular o hash; fazemos o mesmo,
    // senão em arquivo com fim de linha do Windows o script embutido é bloqueado.
    const texto = m[1].replace(/\r\n?/g, '\n');
    if (texto.trim()) hashes.push(`'sha256-${createHash('sha256').update(texto, 'utf8').digest('base64')}'`);
  }
  return hashes;
}

export function buildCsp(scriptHashes: string[]): string {
  return [
    "default-src 'self'",
    `script-src 'self' ${scriptHashes.join(' ')}`.trim(),
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    // ws:/wss: explícitos porque alguns navegadores não aceitam 'self' para WebSocket em IP de rede local.
    "connect-src 'self' ws: wss:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join('; ');
}

export function securityHeaders(distPath: string | null) {
  const csp = buildCsp(inlineScriptHashes(distPath ? path.join(distPath, 'index.html') : null));
  return (_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    // Câmera/microfone/localização não são usados pelo sistema.
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    // API devolve dados de pessoas/vendas: nada de cache em proxy/navegador compartilhado.
    if (_req.path.startsWith('/api')) res.setHeader('Cache-Control', 'no-store');
    next();
  };
}
