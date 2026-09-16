import { Request, Response, NextFunction } from 'express';
import { AuthService } from '../services/AuthService.js';
import { z } from 'zod';

export const loginSchema = z.object({
  username: z.string().min(1, 'Usuário é obrigatório'),
  password: z.string().min(1, 'Senha é obrigatória')
});

export const createUserSchema = z.object({
  name: z.string().min(2, 'Nome é obrigatório'),
  username: z.string().min(3, 'Username deve ter pelo menos 3 caracteres'),
  role: z.enum(['ADMIN', 'CASHIER', 'WAITER', 'KITCHEN']),
  password: z.string().min(4, 'Senha deve ter pelo menos 4 caracteres')
});

export class AuthController {
  static async login(req: Request, res: Response, next: NextFunction) {
    try {
      const { username, password } = req.body;
      const result = AuthService.login(username, password);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  static async createUser(req: Request, res: Response, next: NextFunction) {
    try {
      const { name, username, role, password } = req.body;
      const newUser = AuthService.createUser(name, username, role, password);
      res.status(201).json(newUser);
    } catch (err) {
      next(err);
    }
  }

  static async listUsers(req: Request, res: Response, next: NextFunction) {
    try {
      const users = AuthService.listUsers();
      res.json(users);
    } catch (err) {
      next(err);
    }
  }
}
