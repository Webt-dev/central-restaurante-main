import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../middlewares/authMiddleware.js';
import { OrderService } from '../services/OrderService.js';
import { z } from 'zod';
import { auditRequest } from '../services/AuditService.js';
import { AuthService } from '../services/AuthService.js';
import type { OrderActor } from '../repositories/OrderRepository.js';

export const createOrderSchema = z.object({
  table_id: z.string().min(1, 'ID da mesa é obrigatório'),
  items: z.array(
    z.object({
      menu_item_id: z.string().min(1, 'ID do produto é obrigatório'),
      quantity: z.number().int().positive('Quantidade deve ser inteira e maior que zero'),
      notes: z.string().optional()
    })
  ).min(1, 'Pedido deve conter pelo menos 1 item'),
  notes: z.string().optional(),
  offline_sync_id: z.string().optional()
});

export const updateQuantitySchema = z.object({
  quantity: z.number().int().min(0),
  reason: z.string().trim().max(200).optional(),
  supervisor_pin: z.string().regex(/^\d{4,6}$/).optional()
});

/** Se veio PIN de supervisor, confere e devolve o ator com a autorização. */
async function resolveActor(req: AuthenticatedRequest): Promise<OrderActor> {
  const actor: OrderActor = { userId: req.user!.userId, role: req.user!.role };
  const pin = typeof req.body?.supervisor_pin === 'string' ? req.body.supervisor_pin : undefined;
  if (pin) {
    const supervisor = await AuthService.verifySupervisorPin(pin, req.ip ?? '');
    actor.supervisorId = supervisor.id;
  }
  return actor;
}

export const syncBatchOrdersSchema = z.object({
  batch: z.array(
    z.object({
      table_id: z.string().min(1),
      offline_sync_id: z.string().min(1),
      items: z.array(
        z.object({
          menu_item_id: z.string().min(1),
          quantity: z.number().int().positive(),
          notes: z.string().optional()
        })
      ).min(1),
      notes: z.string().optional()
    })
  ).min(1, 'Lote deve conter pelo menos 1 pedido')
});

export class OrderController {
  static async createOrder(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const waiterId = req.user!.userId;
      const { table_id, items, notes, offline_sync_id } = req.body;

      const order = OrderService.createOrder(waiterId, table_id, items, notes, offline_sync_id);
      res.status(201).json(order);
    } catch (err) {
      next(err);
    }
  }

  static async syncBatch(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const waiterId = req.user!.userId;
      const { batch } = req.body;

      const result = OrderService.syncOfflineBatch(waiterId, batch);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  /** "Excluir" item = cancelamento lógico, com motivo e autor na auditoria. */
  static async deleteItem(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const itemId = req.params.itemId as string;
      const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 200) : undefined;
      const actor = await resolveActor(req);
      const { before } = OrderService.cancelItem(itemId, actor, reason);
      auditRequest(req, {
        action: 'order_item.cancel',
        entity: 'order_item',
        entityId: itemId,
        before,
        after: actor.supervisorId ? { authorized_by: actor.supervisorId } : undefined,
        reason
      });
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  }

  static async updateItemQuantity(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const itemId = req.params.itemId as string;
      const { quantity, reason } = req.body;
      const actor = await resolveActor(req);
      const { before } = OrderService.updateItemQuantity(itemId, quantity, actor, reason);
      auditRequest(req, {
        action: 'order_item.quantity',
        entity: 'order_item',
        entityId: itemId,
        before: { quantity: before.quantity },
        after: { quantity, ...(actor.supervisorId ? { authorized_by: actor.supervisorId } : {}) },
        reason
      });
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  }

  static async getTableBill(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const tableId = req.params.tableId as string;
      const bill = OrderService.getTableBill(tableId);
      res.json(bill);
    } catch (err) {
      next(err);
    }
  }

  static async getOrderById(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const id = req.params.id as string;
      const order = OrderService.getOrderById(id);
      res.json(order);
    } catch (err) {
      next(err);
    }
  }
}
