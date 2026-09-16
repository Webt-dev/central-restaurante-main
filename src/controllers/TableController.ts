import { Request, Response, NextFunction } from 'express';
import { TableService } from '../services/TableService.js';
import { z } from 'zod';

export const createTableSchema = z.object({
  number: z.number().int().positive('Número da mesa deve ser um inteiro positivo'),
  name: z.string().optional()
});

export const updateTableStatusSchema = z.object({
  status: z.enum(['FREE', 'OCCUPIED', 'PAYMENT_PENDING'])
});

export class TableController {
  static async listAll(req: Request, res: Response, next: NextFunction) {
    try {
      const tables = TableService.listAll();
      res.json(tables);
    } catch (err) {
      next(err);
    }
  }

  static async getById(req: Request, res: Response, next: NextFunction) {
    try {
      const id = req.params.id as string;
      const table = TableService.getById(id);
      res.json(table);
    } catch (err) {
      next(err);
    }
  }

  static async createTable(req: Request, res: Response, next: NextFunction) {
    try {
      const { number, name } = req.body;
      const newTable = TableService.createTable(number, name);
      res.status(201).json(newTable);
    } catch (err) {
      next(err);
    }
  }

  static async updateStatus(req: Request, res: Response, next: NextFunction) {
    try {
      const id = req.params.id as string;
      const { status } = req.body;
      const updated = TableService.updateStatus(id, status);
      res.json(updated);
    } catch (err) {
      next(err);
    }
  }
}
