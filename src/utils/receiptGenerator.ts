import fs from 'node:fs';
import path from 'node:path';
import { TableBillSummary, PaymentMethod } from '../models/types.js';
import { getReceiptsDirForDate } from './documentPaths.js';
import { AdminRepository } from '../repositories/AdminRepository.js';

/** Lê a taxa de serviço configurada no painel administrativo. */
function getConfiguredTaxPercent(): number {
  try {
    const pct = Number(AdminRepository.getSettings().service_tax_percent);
    if (!isFinite(pct) || pct < 0) return 0;
    return Math.min(100, pct);
  } catch {
    return 10;
  }
}

function formatPercentLabel(pct: number): string {
  return Number.isInteger(pct) ? String(pct) : String(pct).replace('.', ',');
}

function buildHeader(settings: {
  restaurant_name: string;
  cnpj: string;
  address: string;
  phone: string;
}): string {
  const lines = [
    settings.restaurant_name || 'Central Restaurante',
    settings.cnpj ? `CNPJ: ${settings.cnpj}` : '',
    settings.address || '',
    settings.phone ? `Tel: ${settings.phone}` : ''
  ].filter(Boolean);

  return lines.map(l => l.substring(0, 48)).join('\n');
}

function buildItemLines(tableBill: TableBillSummary): string {
  let itemsLines = '';
  tableBill.items_summary.forEach((item, index) => {
    const itemNum = String(index + 1).padStart(3, '0');
    const namePadded = item.name.padEnd(22, ' ').substring(0, 22);
    const qtyPadded = `${item.quantity}x`.padStart(4, ' ');
    const unitPadded = `R$${item.unit_price.toFixed(2)}`.padStart(9, ' ');
    const totalPadded = `R$${item.total_price.toFixed(2)}`.padStart(10, ' ');
    itemsLines += `${itemNum} ${namePadded} ${qtyPadded} ${unitPadded} ${totalPadded}\n`;
  });
  return itemsLines;
}

export function generateReceiptTxt(
  tableBill: TableBillSummary,
  paymentsInput: { method: PaymentMethod; amount: number; amount_paid?: number }[],
  changeGiven: number,
  cashierName: string = 'Caixa Principal',
  includeTip: boolean = false,
  taxPercent?: number
): { filePath: string; receiptContent: string } {
  const settings = AdminRepository.getSettings();
  const pct = taxPercent !== undefined ? taxPercent : getConfiguredTaxPercent();

  const now = new Date();
  const dirPath = getReceiptsDirForDate(now);
  const dateFormatted = now.toLocaleDateString('pt-BR');
  const timeFormatted = now.toLocaleTimeString('pt-BR');
  const timestampStr = now.toISOString().replace(/[:.]/g, '-');

  const tableNumber = String(tableBill.table.number).padStart(2, '0');
  const fileName = `Mesa_${tableNumber}_${timestampStr}.txt`;
  const filePath = path.join(dirPath, fileName);

  const waiterName = tableBill.orders[0]?.waiter_name || 'Garçom';
  const itemsLines = buildItemLines(tableBill);

  const subtotal = tableBill.total_amount;
  const tipAmount = includeTip && pct > 0 ? Number(((subtotal * pct) / 100).toFixed(2)) : 0;
  const grandTotal = Number((subtotal + tipAmount).toFixed(2));

  const methodMap: Record<PaymentMethod, string> = {
    CASH: 'DINHEIRO',
    CREDIT_CARD: 'CARTAO CREDITO',
    DEBIT_CARD: 'CARTAO DEBITO',
    PIX: 'PIX'
  };

  let paymentLines = '';
  paymentsInput.forEach(p => {
    const methodName = (methodMap[p.method] || p.method).padEnd(20, ' ');
    const valPadded = `R$${p.amount.toFixed(2)}`.padStart(26, ' ');
    paymentLines += `${methodName}${valPadded}\n`;
  });

  const taxLabel = `TAXA DE SERVICO (${formatPercentLabel(pct)}%):`.padEnd(38, ' ');

  const receiptContent = `================================================
${buildHeader(settings)}
================================================
              CUPOM DE CONSUMO
================================================
Mesa: ${tableNumber} (${tableBill.table.name})
Data: ${dateFormatted} ${timeFormatted}
Atendente: ${waiterName}
Operador do caixa: ${cashierName}
------------------------------------------------
ITEM  DESCRICAO              QTD   VL.UNIT      TOTAL
------------------------------------------------
${itemsLines}------------------------------------------------
SUBTOTAL (CONSUMO):                   R$${subtotal.toFixed(2).padStart(8, ' ')}
${taxLabel}R$${tipAmount.toFixed(2).padStart(8, ' ')} ${includeTip && pct > 0 ? '(INCLUIDA)' : '(NAO INCLUIDA)'}
------------------------------------------------
TOTAL PAGO:                           R$${grandTotal.toFixed(2).padStart(8, ' ')}
------------------------------------------------
FORMA(S) DE PAGAMENTO:
${paymentLines}------------------------------------------------
TROCO:                                R$${changeGiven.toFixed(2).padStart(8, ' ')}
================================================
          Obrigado pela preferencia!
================================================
`;

  fs.writeFileSync(filePath, receiptContent, 'utf-8');
  console.log(`Cupom da Mesa ${tableNumber} salvo em: ${filePath}`);

  return { filePath, receiptContent };
}

export function generatePreBillReceiptTxt(
  tableBill: TableBillSummary,
  cashierName: string = 'Caixa Principal',
  taxPercent?: number
): { filePath: string; receiptContent: string } {
  const settings = AdminRepository.getSettings();
  const pct = taxPercent !== undefined ? taxPercent : getConfiguredTaxPercent();

  const now = new Date();
  const dirPath = getReceiptsDirForDate(now);
  const dateFormatted = now.toLocaleDateString('pt-BR');
  const timeFormatted = now.toLocaleTimeString('pt-BR');
  const timestampStr = now.toISOString().replace(/[:.]/g, '-');

  const tableNumber = String(tableBill.table.number).padStart(2, '0');
  const fileName = `PreConta_Mesa_${tableNumber}_${timestampStr}.txt`;
  const filePath = path.join(dirPath, fileName);

  const waiterName = tableBill.orders[0]?.waiter_name || 'Garçom';
  const itemsLines = buildItemLines(tableBill);

  const subtotal = tableBill.total_amount;
  const tipAmount = pct > 0 ? Number(((subtotal * pct) / 100).toFixed(2)) : 0;
  const grandTotalWithTip = Number((subtotal + tipAmount).toFixed(2));

  const taxLabel = `TAXA DE SERVICO (${formatPercentLabel(pct)}%):`.padEnd(38, ' ');

  const taxBlock = pct > 0
    ? `${taxLabel}R$${tipAmount.toFixed(2).padStart(8, ' ')}
------------------------------------------------
TOTAL SEM A TAXA:                     R$${subtotal.toFixed(2).padStart(8, ' ')}
TOTAL COM A TAXA:                     R$${grandTotalWithTip.toFixed(2).padStart(8, ' ')}`
    : `TAXA DE SERVICO:                       DESATIVADA
------------------------------------------------
TOTAL A PAGAR:                        R$${subtotal.toFixed(2).padStart(8, ' ')}`;

  const receiptContent = `================================================
${buildHeader(settings)}
================================================
            CONTA DA MESA (PRE-CONTA)
================================================
Mesa: ${tableNumber} (${tableBill.table.name})
Data: ${dateFormatted} ${timeFormatted}
Atendente: ${waiterName}
Operador do caixa: ${cashierName}
------------------------------------------------
ITEM  DESCRICAO              QTD   VL.UNIT      TOTAL
------------------------------------------------
${itemsLines}------------------------------------------------
SUBTOTAL (CONSUMO):                   R$${subtotal.toFixed(2).padStart(8, ' ')}
${taxBlock}
================================================
      DOCUMENTO APENAS PARA CONFERENCIA
           NAO E DOCUMENTO FISCAL
================================================
          Obrigado pela preferencia!
================================================
`;

  fs.writeFileSync(filePath, receiptContent, 'utf-8');
  console.log(`Pré-conta da Mesa ${tableNumber} salva em: ${filePath}`);

  return { filePath, receiptContent };
}
