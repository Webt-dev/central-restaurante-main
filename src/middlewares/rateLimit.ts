import type { Request, Response, NextFunction } from 'express';

/**
 * Limite global leve de requisições, em memória, por IP (janela fixa de 1 min).
 *
 * Não é proteção contra ataque distribuído (o sistema vive na rede local); serve
 * para um aparelho com defeito/laço infinito ou um script não derrubar o
 * servidor do restaurante. Quem manda token (usuário logado) tem teto alto,
 * porque vários aparelhos legítimos podem sair do mesmo roteador/NAT.
 * Login e setup têm limites próprios (loginThrottle / installCode).
 */
export function createRateLimiter(opts: { authenticatedPerMinute?: number; anonymousPerMinute?: number } = {}) {
  const authLimit = opts.authenticatedPerMinute ?? 600;
  const anonLimit = opts.anonymousPerMinute ?? 120;
  const WINDOW_MS = 60_000;
  const hits = new Map<string, { count: number; resetAt: number }>();

  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }, WINDOW_MS).unref();

  return function rateLimit(req: Request, res: Response, next: NextFunction): void {
    const authenticated = Boolean(req.headers.authorization?.startsWith('Bearer '));
    const key = `${authenticated ? 'a' : 'n'}:${req.ip ?? ''}`;
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + WINDOW_MS };
      hits.set(key, entry);
    }
    entry.count++;

    if (entry.count > (authenticated ? authLimit : anonLimit)) {
      res.setHeader('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      res.status(429).json({ error: 'Muitas requisições em pouco tempo. Aguarde um instante e tente de novo.' });
      return;
    }
    next();
  };
}
