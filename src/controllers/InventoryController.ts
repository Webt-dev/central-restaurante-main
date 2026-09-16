import { Request, Response, NextFunction } from 'express';
import { InventoryService } from '../services/InventoryService.js';
import { z } from 'zod';

export const createInventorySchema = z.object({
  name: z.string().min(1, 'Nome do insumo é obrigatório'),
  unit: z.string().min(1, 'Unidade é obrigatória'),
  quantity: z.number().min(0, 'Quantidade não pode ser negativa'),
  min_quantity: z.number().min(0, 'Quantidade mínima não pode ser negativa'),
  unit_price: z.number().min(0, 'Preço unitário não pode ser negativo')
});

export const adjustInventorySchema = z.object({
  deltaQuantity: z.number()
});

export class InventoryController {
  static async listAll(req: Request, res: Response, next: NextFunction) {
    try {
      const items = InventoryService.listAll();
      res.json(items);
    } catch (err) {
      next(err);
    }
  }

  static async getLowStock(req: Request, res: Response, next: NextFunction) {
    try {
      const items = InventoryService.getLowStock();
      res.json(items);
    } catch (err) {
      next(err);
    }
  }

  static async createItem(req: Request, res: Response, next: NextFunction) {
    try {
      const newItem = InventoryService.createItem(req.body);
      res.status(201).json(newItem);
    } catch (err) {
      next(err);
    }
  }

  static async adjustQuantity(req: Request, res: Response, next: NextFunction) {
    try {
      const id = req.params.id as string;
      const { deltaQuantity } = req.body;
      const updated = InventoryService.adjustQuantity(id, deltaQuantity);
      res.json(updated);
    } catch (err) {
      next(err);
    }
  }
}
