import { CashierRepository, getServiceTaxPercent } from '../repositories/CashierRepository.js';
import { TableRepository } from '../repositories/TableRepository.js';
import { CashRegisterSession, PaymentMethod, DailyReport } from '../models/types.js';
import { notifyPaymentProcessed, notifyTableStatusChanged } from '../sockets/socketManager.js';
import { OrderRepository } from '../repositories/OrderRepository.js';
import * as Fiscal from '../fiscal/FiscalService.js';
import type { DocumentoFiscal } from '../fiscal/FiscalService.js';
import { validarCpf } from '../utils/fiscalUtils.js';
import { HttpError } from '../utils/httpError.js';

export class CashierService {
  static getActiveSession(): CashRegisterSession | null {
    return CashierRepository.getActiveSession();
  }

  static openSession(userId: string, initialBalance: number): CashRegisterSession {
    return CashierRepository.openSession(userId, initialBalance);
  }

  static closeSession(sessionId: string, userId: string, countedCash: number, note?: string): CashRegisterSession {
    return CashierRepository.closeSession(sessionId, userId, countedCash, note);
  }

  static processTablePayment(
    tableId: string,
    cashierUserId: string,
    payments: { method: PaymentMethod; amount: number; amount_paid?: number }[],
    includeTip: boolean = false,
    cpfConsumidor?: string
  ): {
    success: boolean;
    change_given: number;
    service_tax_percent: number;
    message: string;
    receipt_file: string;
    receipt_text: string;
    fiscal: DocumentoFiscal | null;
  } {
    // CPF inválido é recusado ANTES de receber, para não fechar a conta sem conseguir emitir.
    if (cpfConsumidor && !validarCpf(cpfConsumidor)) throw new HttpError(400, 'CPF do consumidor inválido.');

    // Retrato da conta antes de fechar: é o que vai na NFC-e.
    const bill = OrderRepository.getTableBill(tableId);
    const result = CashierRepository.processPayment(tableId, payments, cashierUserId, includeTip);

    // Emissão fiscal (se o módulo estiver ligado) vai para a fila e não segura o caixa.
    let fiscal: DocumentoFiscal | null = null;
    if (bill && Fiscal.isEnabled()) {
      try {
        fiscal = Fiscal.enfileirarCheckout({
          checkoutId: result.payments[0]!.id,
          tableId,
          tableNumber: bill.table.number,
          itens: bill.items_summary,
          consumo: bill.total_amount,
          pagamentos: result.payments.map(p => ({ method: p.payment_method, amount: p.amount })),
          cpf: cpfConsumidor,
          userId: cashierUserId
        });
      } catch (err) {
        console.error('Falha ao enfileirar a NFC-e:', err);
      }
    }

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
      receipt_text: result.receipt_text,
      fiscal
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

  static closeDailyExpedient(dateStr: string | undefined, userId: string, countedCash?: number, note?: string) {
    return CashierRepository.closeDailyExpedient(dateStr, userId, countedCash, note);
  }
}
