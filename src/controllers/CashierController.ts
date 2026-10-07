import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../middlewares/authMiddleware.js';
import { CashierService } from '../services/CashierService.js';
import { z } from 'zod';
import { CashierRepository } from '../repositories/CashierRepository.js';
import { auditRequest } from '../services/AuditService.js';

export const openSessionSchema = z.object({
  initial_balance: z.number().min(0, 'Saldo inicial não pode ser negativo')
});

export const closeSessionSchema = z.object({
  session_id: z.string().min(1),
  counted_cash: z.number().finite().min(0, 'O valor contado não pode ser negativo'),
  note: z.string().trim().max(300).optional()
});

export const cashMovementSchema = z.object({
  type: z.enum(['SANGRIA', 'SUPRIMENTO']),
  amount: z.number().finite().positive('Informe um valor maior que zero').max(1_000_000),
  reason: z.string().trim().min(3, 'Informe o motivo').max(200)
});

export const closeExpedientSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  counted_cash: z.number().finite().min(0).optional(),
  note: z.string().trim().max(300).optional()
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
  ).min(1, 'Deve haver ao menos uma forma de pagamento'),
  /** CPF na nota (opcional, só usado quando a emissão fiscal está ligada). */
  cpf_consumidor: z.string().trim().max(14).optional()
});

export class CashierController {
  static async getActiveSession(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const session = CashierService.getActiveSession();
      // Junto com a sessão vai a conferência: dinheiro esperado na gaveta, sangrias e suprimentos.
      res.json(session ? { ...session, cash: CashierRepository.getCashSummary(session) } : null);
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
      const { session_id, counted_cash, note } = req.body;
      const session = CashierService.closeSession(session_id, userId, counted_cash, note);
      auditRequest(req, { action: 'cashier.close', entity: 'cashier_session', entityId: session_id, after: session, reason: note });
      res.json(session);
    } catch (err) {
      next(err);
    }
  }

  static async processPayment(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const cashierUserId = req.user!.userId;
      const { table_id, payments, include_tip, cpf_consumidor } = req.body;

      const result = CashierService.processTablePayment(table_id, cashierUserId, payments, include_tip, cpf_consumidor || undefined);
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
      const { date, counted_cash, note } = req.body as { date?: string; counted_cash?: number; note?: string };
      const result = CashierService.closeDailyExpedient(date, req.user!.userId, counted_cash, note);
      auditRequest(req, { action: 'cashier.close_expedient', entity: 'cashier_session', after: result.cash_check, reason: note });
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  static async addCashMovement(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const { type, amount, reason } = req.body;
      const movement = CashierRepository.addCashMovement(type, amount, reason, req.user!.userId);
      auditRequest(req, { action: `cashier.${type.toLowerCase()}`, entity: 'cash_movement', entityId: movement.id, after: movement, reason });
      res.status(201).json(movement);
    } catch (err) {
      next(err);
    }
  }
}
