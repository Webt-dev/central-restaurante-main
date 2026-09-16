import { CashierRepository, getServiceTaxPercent } from '../repositories/CashierRepository.js';
import { TableRepository } from '../repositories/TableRepository.js';
import { CashRegisterSession, PaymentMethod, DailyReport } from '../models/types.js';
import { notifyPaymentProcessed, notifyTableStatusChanged } from '../sockets/socketManager.js';

export class CashierService {
  static getActiveSession(): CashRegisterSession | null {
    return CashierRepository.getActiveSession();
  }

  static openSession(userId: string, initialBalance: number): CashRegisterSession {
    return CashierRepository.openSession(userId, initialBalance);
  }

  static closeSession(sessionId: string, userId: string, finalBalance: number): CashRegisterSession {
    return CashierRepository.closeSession(sessionId, userId, finalBalance);
  }

  static processTablePayment(
    tableId: string,
    cashierUserId: string,
    payments: { method: PaymentMethod; amount: number; amount_paid?: number }[],
    includeTip: boolean = false
  ): {
    success: boolean;
    change_given: number;
    service_tax_percent: number;
    message: string;
    receipt_file: string;
    receipt_text: string;
  } {
    const result = CashierRepository.processPayment(tableId, payments, cashierUserId, includeTip);

    const updatedTable = TableRepository.findById(tableId);
    if (updatedTable) {
      notifyTableStatusChanged(updatedTable);
    }

    notifyPaymentProcessed(result.payments);

    return {
      success: true,
      change_given: result.change_given,
      service_tax_percent: result.service_tax_percent,
      message: `Pagamento concluído. Troco: R$ ${result.change_given.toFixed(2)}. Cupom salvo em ${result.receipt_file}`,
      receipt_file: result.receipt_file,
      receipt_text: result.receipt_text
    };
  }

  static reprintReceipt(orderId: string): { receipt_text: string } {
    return CashierRepository.getReceiptByOrderId(orderId);
  }

  static generateTablePreBill(tableId: string, cashierName?: string): { filePath: string; receiptContent: string } {
    return CashierRepository.generateTablePreBill(tableId, cashierName);
  }

  /** Percentual da taxa de serviço configurado no painel administrativo. */
  static getServiceTaxPercent(): number {
    return getServiceTaxPercent();
  }

  static getDailyReport(dateStr?: string): DailyReport {
    return CashierRepository.getDailyReport(dateStr);
  }

  static closeDailyExpedient(dateStr?: string, userId?: string) {
    return CashierRepository.closeDailyExpedient(dateStr, userId);
  }
}
