import { Request, Response, NextFunction } from 'express';
import { KitchenService } from '../services/KitchenService.js';
import { z } from 'zod';

export const updateItemStatusSchema = z.object({
  status: z.enum(['PENDING', 'PREPARING', 'READY', 'DELIVERED', 'CANCELLED'])
});

export const updateBatchStatusSchema = z.object({
  status: z.enum(['PENDING', 'PREPARING', 'READY', 'DELIVERED', 'CANCELLED']),
  filterType: z.enum(['FOOD', 'DRINK', 'BAR']).optional()
});

export class KitchenController {
  static async getKitchenQueue(req: Request, res: Response, next: NextFunction) {
    try {
      const queue = KitchenService.listKitchenQueue();
      res.json(queue);
    } catch (err) {
      next(err);
    }
  }

  static async getBarQueue(req: Request, res: Response, next: NextFunction) {
    try {
      const queue = KitchenService.listBarQueue();
      res.json(queue);
    } catch (err) {
      next(err);
    }
  }

  static async updateItemStatus(req: Request, res: Response, next: NextFunction) {
    try {
      const itemId = req.params.itemId as string;
      const { status } = req.body;

      const updatedOrder = KitchenService.updateItemStatus(itemId, status);
      res.json(updatedOrder);
    } catch (err) {
      next(err);
    }
  }

  static async updateOrderBatchStatus(req: Request, res: Response, next: NextFunction) {
    try {
      const orderId = req.params.orderId as string;
      const { status, filterType } = req.body;

      const updatedOrder = KitchenService.updateOrderBatchStatus(orderId, status, filterType);
      res.json(updatedOrder);
    } catch (err) {
      next(err);
    }
  }
}
