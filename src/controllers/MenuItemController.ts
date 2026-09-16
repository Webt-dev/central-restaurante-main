import { Request, Response, NextFunction } from 'express';
import { MenuItemService } from '../services/MenuItemService.js';
import { z } from 'zod';

export const createMenuItemSchema = z.object({
  name: z.string().min(1, 'Nome do item é obrigatório'),
  description: z.string().default(''),
  price: z.number().positive('Preço deve ser positivo'),
  category: z.string().min(1, 'Categoria é obrigatória'),
  ingredients: z.array(
    z.object({
      inventory_id: z.string(),
      quantity_required: z.number().positive()
    })
  ).optional()
});

export class MenuItemController {
  static async listAll(req: Request, res: Response, next: NextFunction) {
    try {
      const items = MenuItemService.listAll();
      res.json(items);
    } catch (err) {
      next(err);
    }
  }

  static async getById(req: Request, res: Response, next: NextFunction) {
    try {
      const id = req.params.id as string;
      const item = MenuItemService.getById(id);
      res.json(item);
    } catch (err) {
      next(err);
    }
  }

  static async createItem(req: Request, res: Response, next: NextFunction) {
    try {
      const newItem = MenuItemService.createItem(req.body);
      res.status(201).json(newItem);
    } catch (err) {
      next(err);
    }
  }
}
