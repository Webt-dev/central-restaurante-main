import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { AuthService } from '../services/AuthService.js';
import { AuthenticatedRequest } from '../middlewares/authMiddleware.js';
import { auditRequest, audit } from '../services/AuditService.js';
import { checkInstallCode, discardInstallCode } from '../config/installCode.js';
import { HttpError } from '../utils/httpError.js';
import { disconnectUser } from '../sockets/socketManager.js';

const roleSchema = z.enum(['ADMIN', 'CASHIER', 'WAITER', 'KITCHEN']);
const usernameSchema = z.string().trim().min(3, 'O usuário deve ter pelo menos 3 caracteres').max(40)
  .regex(/^[a-zA-Z0-9._-]+$/, 'Use apenas letras, números, ponto, hífen ou sublinhado');

export const loginSchema = z.object({
  username: z.string().trim().min(1, 'Usuário é obrigatório'),
  password: z.string().min(1, 'Senha é obrigatória')
});

export const setupSchema = z.object({
  name: z.string().trim().min(2, 'Nome é obrigatório').max(80),
  username: usernameSchema,
  password: z.string().min(1),
  // Código mostrado no console/log do servidor no primeiro boot (ver config/installCode.ts).
  installCode: z.string().trim().max(40).optional()
});

export const createUserSchema = z.object({
  name: z.string().trim().min(2, 'Nome é obrigatório').max(80),
  username: usernameSchema,
  role: roleSchema,
  password: z.string().min(1)
});

export const updateUserSchema = z.object({
  name: z.string().trim().min(2).max(80),
  role: roleSchema,
  active: z.boolean()
});

export const resetPasswordSchema = z.object({
  password: z.string().min(1)
});

export const setPinSchema = z.object({
  currentPassword: z.string().min(1, 'Informe a senha atual'),
  pin: z.string().regex(/^\d{4,6}$/, 'O PIN deve ter de 4 a 6 números').nullable()
});

export const changeOwnCredentialsSchema = z.object({
  currentPassword: z.string().min(1, 'Informe a senha atual'),
  newUsername: usernameSchema.optional(),
  newPassword: z.string().min(1)
});

function param(value: unknown): string {
  return Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '');
}

export class AuthController {
  static async login(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const { username, password } = req.body;
      res.json(await AuthService.login(username, password, req.ip ?? ''));
    } catch (err) {
      next(err);
    }
  }

  static setupStatus(req: AuthenticatedRequest, res: Response) {
    // needsInstallCode avisa a tela de que deve pedir o código mostrado no servidor.
    res.json({ needsSetup: AuthService.needsSetup(), needsInstallCode: AuthService.needsSetup() });
  }

  static async setup(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const { name, username, password, installCode } = req.body;
      // Já configurado: 409 como antes, sem mexer no contador de tentativas do código.
      if (!AuthService.needsSetup()) throw new HttpError(409, 'O sistema já foi configurado.');
      const check = checkInstallCode(installCode, req.ip ?? '');
      if (check === 'locked') throw new HttpError(429, 'Muitas tentativas com código errado. Aguarde 15 minutos.', 'INSTALL_CODE_LOCKED');
      if (check !== 'ok') {
        throw new HttpError(403, 'Código de instalação inválido. Ele aparece na tela/log do servidor no primeiro início.', 'INSTALL_CODE_INVALID');
      }
      const result = await AuthService.setup(name, username, password, req.ip ?? '');
      discardInstallCode();
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  }

  static me(req: AuthenticatedRequest, res: Response) {
    const { userId, name, role } = req.user!;
    res.json({ id: userId, name, role });
  }

  static async changeOwnCredentials(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const result = await AuthService.changeOwnCredentials(req.user!.userId, req.body);
      auditRequest(req, { action: 'user.change_own_credentials', entity: 'user', entityId: req.user!.userId });
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  static async setOwnPin(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      await AuthService.setOwnPin(req.user!.userId, req.body.currentPassword, req.body.pin);
      auditRequest(req, { action: req.body.pin ? 'user.set_pin' : 'user.remove_pin', entity: 'user', entityId: req.user!.userId });
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  }

  static async createUser(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const { name, username, role, password } = req.body;
      const user = await AuthService.createUser(name, username, role, password);
      auditRequest(req, { action: 'user.create', entity: 'user', entityId: user.id, after: user });
      res.status(201).json(user);
    } catch (err) {
      next(err);
    }
  }

  static listUsers(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      res.json(AuthService.listUsers());
    } catch (err) {
      next(err);
    }
  }

  static updateUser(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const id = param(req.params.id);
      const { before, after } = AuthService.updateUser(req.user!.userId, id, req.body);
      auditRequest(req, { action: 'user.update', entity: 'user', entityId: id, before, after });
      disconnectUser(id);
      res.json(after);
    } catch (err) {
      next(err);
    }
  }

  static async resetPassword(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const id = param(req.params.id);
      const user = await AuthService.resetPassword(id, req.body.password);
      auditRequest(req, { action: 'user.reset_password', entity: 'user', entityId: id });
      disconnectUser(id);
      res.json(user);
    } catch (err) {
      next(err);
    }
  }

  static logout(req: AuthenticatedRequest, res: Response) {
    if (req.user) {
      audit({
        action: 'auth.logout',
        entity: 'user',
        entityId: req.user.userId,
        userId: req.user.userId,
        userName: req.user.name,
        role: req.user.role,
        ip: req.ip ?? null
      });
    }
    res.json({ success: true });
  }
}
