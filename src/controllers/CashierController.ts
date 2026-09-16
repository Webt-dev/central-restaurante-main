import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../middlewares/authMiddleware.js';
import { CashierService } from '../services/CashierService.js';
import { z } from 'zod';

export const openSessionSchema = z.object({
  initial_balance: z.number().min(0, 'Saldo inicial não pode ser negativo')
});

export const closeSessionSchema = z.object({
  session_id: z.string().min(1),
  final_balance: z.number().min(0, 'Saldo final não pode ser negativo')
});

export const processPaymentSchema = z.object({
  table_id: z.string().min(1, 'ID da mesa é obrigatório'),
  include_tip: z.boolean().optional(),
  payments: z.array(
    z.object({
      method: z.enum(['CASH', 'CREDIT_CARD', 'DEBIT_CARD', 'PIX']),
      amount: z.number().positive('Valor do pagamento deve ser positivo'),
      amount_paid: z.number().positive().optional()
    })
  ).min(1, 'Deve haver ao menos uma forma de pagamento')
});

export class CashierController {
  static async getActiveSession(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const session = CashierService.getActiveSession();
      res.json(session);
    } catch (err) {
      next(err);
    }
  }

  static async openSession(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.userId;
      const { initial_balance } = req.body;
      const session = CashierService.openSession(userId, initial_balance);
      res.status(201).json(session);
    } catch (err) {
      next(err);
    }
  }

  static async closeSession(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.userId;
      const { session_id, final_balance } = req.body;
      const session = CashierService.closeSession(session_id, userId, final_balance);
      res.json(session);
    } catch (err) {
      next(err);
    }
  }

  static async processPayment(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const cashierUserId = req.user!.userId;
      const { table_id, payments, include_tip } = req.body;

      const result = CashierService.processTablePayment(table_id, cashierUserId, payments, include_tip);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  static async reprintReceipt(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const orderId = req.params.orderId as string;
      const result = CashierService.reprintReceipt(orderId);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  static async printTableBill(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const tableId = req.params.tableId as string;
      const cashierName = req.user?.name || 'Caixa Principal';
      const result = CashierService.generateTablePreBill(tableId, cashierName);
      res.json({
        success: true,
        receipt_file: result.filePath,
        receipt_text: result.receiptContent
      });
    } catch (err) {
      next(err);
    }
  }

  static async getDailyReport(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const dateStr = req.query.date as string | undefined;
      const report = CashierService.getDailyReport(dateStr);
      res.json(report);
    } catch (err) {
      next(err);
    }
  }

  static async closeDailyExpedient(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const dateStr = req.body.date as string | undefined;
      const userId = req.user?.userId || 'u_caixa';
      const result = CashierService.closeDailyExpedient(dateStr, userId);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
}
