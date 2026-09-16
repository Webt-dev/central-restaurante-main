import { Request, Response, NextFunction } from 'express';
import { verifyToken, TokenPayload } from '../utils/crypto.js';
import { UserRole } from '../models/types.js';

export interface AuthenticatedRequest extends Request {
  user?: TokenPayload;
}

export function authenticate(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Acesso não autorizado. Token Bearer ausente.' });
    return;
  }

  const token = authHeader.split(' ')[1];
  if (!token) {
    res.status(401).json({ error: 'Token de autenticação malformado.' });
    return;
  }

  const payload = verifyToken(token);
  if (!payload) {
    res.status(401).json({ error: 'Token inválido ou expirado.' });
    return;
  }

  req.user = payload;
  next();
}

export function authorize(roles: UserRole[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Não autenticado.' });
      return;
    }

    if (!roles.includes(req.user.role) && req.user.role !== 'ADMIN') {
      res.status(403).json({ error: `Acesso negado. Requer função: ${roles.join(' ou ')}.` });
      return;
    }

    next();
  };
}
