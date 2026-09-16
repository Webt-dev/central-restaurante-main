import fs from 'node:fs';
import path from 'node:path';
import { getReportsDirForDate } from './documentPaths.js';

function formatPercentLabel(pct: number): string {
  return Number.isInteger(pct) ? String(pct) : String(pct).replace('.', ',');
}

export function generateExpedientReportTxt(expedientData: {
  closed_at: string;
  report: any;
  analytics: any;
  inventory_consumed: any[];
  service_tax_percent?: number;
}): { filePath: string; reportContent: string } {
  const d = new Date(expedientData.closed_at);
  const dirPath = getReportsDirForDate(d);

  const dateFormatted = d.toLocaleDateString('pt-BR');
  const timeFormatted = d.toLocaleTimeString('pt-BR');
  const timestampStr = d.toISOString().replace(/[:.]/g, '-');

  const fileName = `Relatorio_Expediente_${timestampStr}.txt`;
  const filePath = path.join(dirPath, fileName);

  const report = expedientData.report || {};
  const analytics = expedientData.analytics || {};
  const consumed = expedientData.inventory_consumed || [];
  const pct = Number(expedientData.service_tax_percent ?? 10);
  const taxLabel = `TAXA DE SERVICO (${formatPercentLabel(pct)}%):`.padEnd(38, ' ');

  let consumedLines = '';
  if (consumed.length === 0) {
    consumedLines = 'Nenhum insumo descontado do estoque hoje.\n';
  } else {
    consumed.forEach((inv, idx) => {
      const idxStr = String(idx + 1).padStart(2, '0');
      const namePadded = inv.name.padEnd(35, ' ').substring(0, 35);
      const qtyStr = `-${inv.total_consumed} ${inv.unit}`.padStart(15, ' ');
      consumedLines += `${idxStr}. ${namePadded} ${qtyStr}\n`;
    });
  }

  let tableDetailLines = '';
  if (report.table_orders_detail && report.table_orders_detail.length > 0) {
    report.table_orders_detail.forEach((ord: any) => {
      const mNum = String(ord.table_number).padStart(2, '0');
      const waiter = (ord.waiter_name || 'Garcom').padEnd(15, ' ');
      const totalStr = `R$ ${ord.total_amount.toFixed(2)}`.padStart(10, ' ');
      tableDetailLines += `Mesa ${mNum} | ${waiter} | Fechada em: ${ord.closed_at} | Consumo: ${totalStr}\n`;
      if (ord.items && ord.items.length > 0) {
        ord.items.forEach((it: any) => {
          tableDetailLines += `   - ${it.quantity}x ${it.name} (R$ ${it.total_price.toFixed(2)})\n`;
        });
      }
      tableDetailLines += '----------------------------------------------------------------------\n';
    });
  } else {
    tableDetailLines = 'Nenhuma conta encerrada no dia.\n';
  }

  const reportContent = `======================================================================
              RELATORIO DE EXPEDIENTE - CENTRAL RESTAURANTE
======================================================================
Data do expediente: ${dateFormatted}
Encerrado as: ${timeFormatted}
======================================================================

1. RESUMO FINANCEIRO
----------------------------------------------------------------------
FATURAMENTO TOTAL:                    R$ ${report.total_sales?.toFixed(2) || '0.00'}
CONSUMO (SEM A TAXA):                 R$ ${report.total_sales_subtotal?.toFixed(2) || '0.00'}
${taxLabel}R$ ${report.total_sales_tips?.toFixed(2) || '0.00'}
----------------------------------------------------------------------
Contas encerradas: ${report.total_orders_closed || 0}

VENDAS POR FORMA DE PAGAMENTO:
- PIX:                 R$ ${report.by_payment_method?.PIX?.toFixed(2) || '0.00'}
- Cartao de credito:   R$ ${report.by_payment_method?.CREDIT_CARD?.toFixed(2) || '0.00'}
- Cartao de debito:    R$ ${report.by_payment_method?.DEBIT_CARD?.toFixed(2) || '0.00'}
- Dinheiro:            R$ ${report.by_payment_method?.CASH?.toFixed(2) || '0.00'}

2. DESTAQUES DO DIA
----------------------------------------------------------------------
Prato mais vendido:    ${analytics.top_food?.name || 'Nenhum'} (${analytics.top_food?.total_qty || 0} un - R$ ${analytics.top_food?.total_revenue?.toFixed(2) || '0.00'})
Bebida mais vendida:   ${analytics.top_drink?.name || 'Nenhuma'} (${analytics.top_drink?.total_qty || 0} un - R$ ${analytics.top_drink?.total_revenue?.toFixed(2) || '0.00'})
Mesa que mais faturou: Mesa ${analytics.top_table?.table_number || 0} (R$ ${analytics.top_table?.total_revenue?.toFixed(2) || '0.00'})
Pagamento mais usado:  ${analytics.top_payment?.payment_method || 'N/A'} (R$ ${analytics.top_payment?.total_revenue?.toFixed(2) || '0.00'})

3. INSUMOS DESCONTADOS DO ESTOQUE
----------------------------------------------------------------------
${consumedLines}
4. CONTAS FECHADAS POR MESA
----------------------------------------------------------------------
${tableDetailLines}======================================================================
                      FIM DO RELATORIO
======================================================================
`;

  fs.writeFileSync(filePath, reportContent, 'utf-8');
  console.log(`Relatório de expediente salvo em: ${filePath}`);

  return { filePath, reportContent };
}
