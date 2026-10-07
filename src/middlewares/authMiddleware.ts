import { Request, Response, NextFunction } from 'express';
import { verifyToken, TokenPayload } from '../utils/crypto.js';
import { UserRole } from '../models/types.js';
import { UserRepository } from '../repositories/UserRepository.js';

export interface AuthenticatedRequest extends Request {
  user?: TokenPayload;
}

/**
 * Valida o token E confere o usuário no banco a cada requisição: um usuário
 * desativado, ou que trocou de senha/papel, perde o acesso na hora em vez de
 * continuar com o token antigo até ele expirar.
 */
export function resolveSession(token: string | undefined): TokenPayload | null {
  if (!token) return null;
  const payload = verifyToken(token);
  if (!payload) return null;

  const user = UserRepository.findById(payload.userId);
  if (!user || !user.active || user.token_version !== payload.tv) return null;

  return { ...payload, name: user.name, role: user.role };
}

/** Rotas liberadas para quem ainda precisa trocar a senha de fábrica. */
const PASSWORD_CHANGE_ALLOWED = ['/api/auth/me', '/api/auth/me/credentials', '/api/auth/logout'];

export function authenticate(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;

  const session = resolveSession(token);
  if (!session) {
    res.status(401).json({ error: 'Sessão inválida ou expirada. Faça login novamente.' });
    return;
  }

  if (session.mcp && !PASSWORD_CHANGE_ALLOWED.includes(req.originalUrl.split('?')[0]!)) {
    res.status(403).json({ error: 'Troque a senha de fábrica antes de continuar.', code: 'PASSWORD_CHANGE_REQUIRED' });
    return;
  }

  req.user = session;
  next();
}

/** ADMIN sempre passa; os demais papéis precisam estar na lista. */
export function authorize(roles: UserRole[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Não autenticado.' });
      return;
    }

    if (req.user.role !== 'ADMIN' && !roles.includes(req.user.role)) {
      res.status(403).json({ error: 'Seu usuário não tem permissão para esta ação.' });
      return;
    }

    next();
  };
}
