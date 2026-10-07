import { db } from '../config/database.js';
import { CashRegisterSession, Payment, PaymentMethod, DailyReport } from '../models/types.js';
import { TableRepository } from './TableRepository.js';
import { OrderRepository } from './OrderRepository.js';
import { InventoryRepository } from './InventoryRepository.js';
import { AdminRepository } from './AdminRepository.js';
import { generateReceiptTxt, generatePreBillReceiptTxt } from '../utils/receiptGenerator.js';
import { generateExpedientReportTxt } from '../utils/expedientReportGenerator.js';
import { randomUUID } from 'node:crypto';
import { HttpError } from '../utils/httpError.js';
import { toCents, toReais, percentOf } from '../utils/money.js';

function getLocalDateStr(): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Percentual da taxa de serviço configurado em Gestão > Configurações.
 * Antes o valor era fixo em 10% no código; agora respeita o painel administrativo.
 */
export function getServiceTaxPercent(): number {
  try {
    const pct = Number(AdminRepository.getSettings().service_tax_percent);
    if (!isFinite(pct) || pct < 0) return 0;
    return Math.min(100, pct);
  } catch {
    return 0;
  }
}

function applyServiceTax(subtotal: number, includeTip: boolean): { percent: number; tip: number; total: number } {
  const percent = getServiceTaxPercent();
  const tip = includeTip && percent > 0 ? percentOf(subtotal, percent) : 0;
  return { percent, tip, total: toReais(toCents(subtotal) + toCents(tip)) };
}

export interface CashMovement {
  id: string;
  session_id: string;
  type: 'SANGRIA' | 'SUPRIMENTO';
  amount: number;
  reason: string;
  user_id: string;
  user_name?: string;
  created_at: string;
}

export interface CashSummary {
  initial_balance: number;
  cash_sales: number;
  suprimentos: number;
  sangrias: number;
  /** Fundo de troco + vendas em dinheiro + suprimentos − sangrias. */
  expected_cash: number;
  movements: CashMovement[];
}

export class CashierRepository {
  static getActiveSession(): CashRegisterSession | null {
    const session = db.prepare(`
      SELECT cs.*, u1.name as opened_by_name, u2.name as closed_by_name
      FROM cashier_sessions cs
      JOIN users u1 ON u1.id = cs.opened_by_id
      LEFT JOIN users u2 ON u2.id = cs.closed_by_id
      WHERE cs.status = 'OPEN'
      ORDER BY cs.opened_at DESC
      LIMIT 1
    `).get() as CashRegisterSession | undefined;

    return session || null;
  }

  static openSession(userId: string, initialBalance: number): CashRegisterSession {
    const active = this.getActiveSession();
    if (active) return active;

    const id = randomUUID();
    db.prepare(`
      INSERT INTO cashier_sessions (id, opened_by_id, initial_balance, status)
      VALUES (?, ?, ?, 'OPEN')
    `).run(id, userId, initialBalance);

    return this.getActiveSession()!;
  }

  static listCashMovements(sessionId: string): CashMovement[] {
    return db.prepare(`
      SELECT cm.*, u.name as user_name
      FROM cash_movements cm
      JOIN users u ON u.id = cm.user_id
      WHERE cm.session_id = ?
      ORDER BY cm.created_at ASC
    `).all(sessionId) as CashMovement[];
  }

  static getCashSummary(session: CashRegisterSession): CashSummary {
    const movements = this.listCashMovements(session.id);
    const sum = (type: CashMovement['type']) => movements.filter(m => m.type === type).reduce((acc, m) => acc + toCents(m.amount), 0);
    const expected = toCents(session.initial_balance) + toCents(session.total_cash) + sum('SUPRIMENTO') - sum('SANGRIA');
    return {
      initial_balance: session.initial_balance,
      cash_sales: session.total_cash,
      suprimentos: toReais(sum('SUPRIMENTO')),
      sangrias: toReais(sum('SANGRIA')),
      expected_cash: toReais(expected),
      movements
    };
  }

  /** Sangria (retirada) ou suprimento (reforço de troco) na gaveta do caixa aberto. */
  static addCashMovement(type: CashMovement['type'], amount: number, reason: string, userId: string): CashMovement {
    const session = this.getActiveSession();
    if (!session) throw new HttpError(409, 'Não há caixa aberto. Abra o caixa antes.');
    const cents = toCents(amount);
    if (cents <= 0) throw new HttpError(400, 'Informe um valor maior que zero.');
    if (type === 'SANGRIA' && cents > toCents(this.getCashSummary(session).expected_cash)) {
      throw new HttpError(400, 'A sangria é maior que o dinheiro esperado na gaveta.');
    }

    const id = randomUUID();
    db.prepare(`
      INSERT INTO cash_movements (id, session_id, type, amount, reason, user_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, session.id, type, toReais(cents), reason, userId);
    return this.listCashMovements(session.id).find(m => m.id === id)!;
  }

  /**
   * Fecha o caixa com conferência: grava o dinheiro esperado, o contado e a
   * diferença (antes gravava como "saldo final" o que o operador digitasse,
   * sem comparar com nada).
   */
  static closeSession(sessionId: string, userId: string, countedCash: number, note?: string): CashRegisterSession & { expected_cash: number; counted_cash: number; cash_difference: number } {
    const session = this.getActiveSession();
    if (!session || session.id !== sessionId) {
      throw new HttpError(404, 'Sessão de caixa não encontrada ou já encerrada.');
    }

    const expected = this.getCashSummary(session).expected_cash;
    const counted = toReais(toCents(countedCash));
    const difference = toReais(toCents(counted) - toCents(expected));
    if (difference !== 0 && !note?.trim()) {
      throw new HttpError(400, `Há diferença de R$ ${difference.toFixed(2)} no caixa. Explique na observação para encerrar.`);
    }

    db.prepare(`
      UPDATE cashier_sessions
      SET closed_by_id = ?, closed_at = datetime('now', 'localtime'), final_balance = ?, status = 'CLOSED',
          expected_cash = ?, counted_cash = ?, cash_difference = ?, closing_note = ?
      WHERE id = ?
    `).run(userId, counted, expected, counted, difference, note?.trim() || null, sessionId);

    return db.prepare('SELECT * FROM cashier_sessions WHERE id = ?').get(sessionId) as any;
  }

  static generateTablePreBill(tableId: string, cashierName: string = 'Operador Caixa'): { filePath: string; receiptContent: string } {
    const tableBill = OrderRepository.getTableBill(tableId);
    if (!tableBill || tableBill.orders.length === 0) {
      throw new Error('Nenhum pedido aberto encontrado para esta mesa.');
    }

    const session = this.getActiveSession();
    const opName = session?.opened_by_name || cashierName;

    return generatePreBillReceiptTxt(tableBill, opName, getServiceTaxPercent());
  }

  static processPayment(
    tableId: string,
    paymentsInput: { method: PaymentMethod; amount: number; amount_paid?: number }[],
    cashierUserId: string,
    includeTip: boolean = false
  ): { payments: Payment[]; change_given: number; receipt_file: string; receipt_text: string; service_tax_percent: number } {
    let session = this.getActiveSession();
    if (!session) {
      session = this.openSession(cashierUserId, 0);
    }

    const tableBill = OrderRepository.getTableBill(tableId);
    if (!tableBill || tableBill.orders.length === 0) {
      throw new Error('Nenhum pedido aberto encontrado para esta mesa.');
    }

    // Tudo em centavos. Cartão e Pix não geram troco: o valor recebido é o próprio pagamento.
    const inputs = paymentsInput.map(p => {
      const amount = toCents(p.amount);
      const paid = p.method === 'CASH' && p.amount_paid !== undefined ? toCents(p.amount_paid) : amount;
      return { method: p.method, amount, paid };
    });
    if (inputs.some(p => p.amount <= 0 || p.paid < p.amount)) {
      throw new HttpError(400, 'Valores de pagamento inválidos.');
    }

    const subtotal = tableBill.total_amount;
    const { percent, total: requiredTotal } = applyServiceTax(subtotal, includeTip);
    const requiredCents = toCents(requiredTotal);
    const totalPaidCents = inputs.reduce((acc, p) => acc + p.paid, 0);

    if (totalPaidCents < requiredCents) {
      throw new HttpError(400,
        `O valor pago (R$ ${toReais(totalPaidCents).toFixed(2)}) é menor que o total da conta (R$ ${requiredTotal.toFixed(2)}).`
      );
    }

    const createdPayments: Payment[] = [];
    let totalChangeCents = 0;

    const processTransaction = db.transaction(() => {
      let remaining = requiredCents;

      for (const p of inputs) {
        const applied = Math.min(p.amount, remaining);
        const change = p.method === 'CASH' ? Math.max(0, p.paid - applied) : 0;
        totalChangeCents += change;
        remaining -= applied;

        const paymentAmount = toReais(applied);
        const amountPaid = toReais(p.paid);
        const changeReais = toReais(change);
        const paymentId = randomUUID();
        const orderId = tableBill.orders[0]!.id;

        db.prepare(`
          INSERT INTO payments (id, table_id, order_id, cashier_session_id, payment_method, amount, amount_paid, change_given)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(paymentId, tableId, orderId, session!.id, p.method, paymentAmount, amountPaid, changeReais);

        const column = p.method === 'CASH' ? 'total_cash' : p.method === 'PIX' ? 'total_pix' : 'total_card';
        db.prepare(`UPDATE cashier_sessions SET total_sales = ROUND(total_sales + ?, 2), ${column} = ROUND(${column} + ?, 2) WHERE id = ?`)
          .run(paymentAmount, paymentAmount, session!.id);

        createdPayments.push({
          id: paymentId,
          table_id: tableId,
          order_id: orderId,
          cashier_session_id: session!.id,
          payment_method: p.method,
          amount: paymentAmount,
          amount_paid: amountPaid,
          change_given: changeReais,
          created_at: new Date().toISOString()
        });
      }

      for (const order of tableBill.orders) {
        db.prepare("UPDATE orders SET status = 'CLOSED', cashier_session_id = ?, updated_at = datetime('now', 'localtime') WHERE id = ?").run(session!.id, order.id);
      }

      TableRepository.updateStatus(tableId, 'FREE');
    });

    processTransaction();

    const receiptResult = generateReceiptTxt(
      tableBill,
      paymentsInput,
      toReais(totalChangeCents),
      session.opened_by_name,
      includeTip && percent > 0,
      percent
    );

    return {
      payments: createdPayments,
      change_given: toReais(totalChangeCents),
      receipt_file: receiptResult.filePath,
      receipt_text: receiptResult.receiptContent,
      service_tax_percent: percent
    };
  }

  static getReceiptByOrderId(orderId: string): { receipt_text: string } {
    const order = db.prepare(`
      SELECT o.*, t.number as table_number, t.name as table_name, u.name as waiter_name
      FROM orders o
      JOIN tables t ON t.id = o.table_id
      JOIN users u ON u.id = o.waiter_id
      WHERE o.id = ?
    `).get(orderId) as any;

    if (!order) {
      throw new Error('Pedido encerrado não encontrado.');
    }

    const items = db.prepare(`
      SELECT oi.*, mi.name as menu_item_name
      FROM order_items oi
      JOIN menu_items mi ON mi.id = oi.menu_item_id
      WHERE oi.order_id = ?
    `).all(orderId) as any[];

    const payments = db.prepare('SELECT * FROM payments WHERE order_id = ?').all(orderId) as any[];

    const tableBill = {
      table: { id: order.table_id, number: order.table_number, name: order.table_name, status: 'FREE' },
      orders: [{ ...order, items }],
      total_amount: order.total_amount,
      items_summary: items.map(i => ({
        menu_item_id: i.menu_item_id,
        name: i.menu_item_name,
        quantity: i.quantity,
        unit_price: i.unit_price,
        total_price: i.total_price
      }))
    };

    const paymentsInput = payments.map(p => ({
      method: p.payment_method,
      amount: p.amount,
      amount_paid: p.amount_paid
    }));

    const totalPaid = payments.reduce((acc, p) => acc + (p.amount || 0), 0);
    const totalChange = payments.reduce((acc, p) => acc + (p.change_given || 0), 0);

    // Reconstrói se a taxa de serviço havia sido cobrada nesta conta.
    const tipCharged = totalPaid > Number(order.total_amount) + 0.01;
    const percent = tipCharged && order.total_amount > 0
      ? Number((((totalPaid - order.total_amount) / order.total_amount) * 100).toFixed(2))
      : getServiceTaxPercent();

    const receiptResult = generateReceiptTxt(
      tableBill as any,
      paymentsInput as any,
      totalChange,
      'Operador Caixa',
      tipCharged,
      percent
    );

    return { receipt_text: receiptResult.receiptContent };
  }

  static getDailyReport(dateStr?: string): DailyReport {
    const targetDate = dateStr || getLocalDateStr();

    const session = db.prepare(`
      SELECT cs.*, u1.name as opened_by_name, u2.name as closed_by_name
      FROM cashier_sessions cs
      JOIN users u1 ON u1.id = cs.opened_by_id
      LEFT JOIN users u2 ON u2.id = cs.closed_by_id
      WHERE (date(cs.opened_at) = date(?) OR date(cs.opened_at) = date('now', 'localtime'))
      ORDER BY cs.opened_at DESC
      LIMIT 1
    `).get(targetDate) as CashRegisterSession | undefined;

    const by_payment_method = { CASH: 0, CREDIT_CARD: 0, DEBIT_CARD: 0, PIX: 0 };

    if (!session) {
      return {
        date: targetDate,
        cashier_session: null,
        total_sales: 0,
        total_sales_subtotal: 0,
        total_sales_tips: 0,
        total_orders_closed: 0,
        by_payment_method,
        table_orders_detail: [],
        inventory_alerts: InventoryRepository.findLowStock()
      };
    }

    const paymentTotals = db.prepare(`
      SELECT payment_method, SUM(amount) as total
      FROM payments
      WHERE cashier_session_id = ?
      GROUP BY payment_method
    `).all(session.id) as { payment_method: PaymentMethod; total: number }[];

    let total_sales = 0;
    for (const p of paymentTotals) {
      if (p.payment_method in by_payment_method) {
        by_payment_method[p.payment_method] = p.total;
        total_sales += p.total;
      }
    }

    const closedOrders = db.prepare(`
      SELECT DISTINCT o.id as order_id, o.total_amount, o.updated_at as closed_at, t.number as table_number, u.name as waiter_name
      FROM orders o
      JOIN tables t ON t.id = o.table_id
      JOIN users u ON u.id = o.waiter_id
      WHERE (o.cashier_session_id = ? OR o.id IN (SELECT order_id FROM payments WHERE cashier_session_id = ?))
        AND o.status = 'CLOSED'
      ORDER BY o.updated_at ASC
    `).all(session.id, session.id) as { order_id: string; total_amount: number; closed_at: string; table_number: number; waiter_name: string }[];

    const getItemDetails = db.prepare(`
      SELECT mi.name, oi.quantity, oi.unit_price, oi.total_price
      FROM order_items oi
      JOIN menu_items mi ON mi.id = oi.menu_item_id
      WHERE oi.order_id = ?
    `);

    const getPaymentDetails = db.prepare(`
      SELECT payment_method as method, amount
      FROM payments
      WHERE order_id = ?
    `);

    const table_orders_detail = closedOrders.map(order => ({
      table_number: order.table_number,
      order_id: order.order_id,
      waiter_name: order.waiter_name,
      total_amount: order.total_amount,
      closed_at: order.closed_at,
      items: getItemDetails.all(order.order_id) as { name: string; quantity: number; unit_price: number; total_price: number }[],
      payments: getPaymentDetails.all(order.order_id) as { method: PaymentMethod; amount: number }[]
    }));

    const inventory_alerts = InventoryRepository.findLowStock();

    const total_sales_subtotal = closedOrders.reduce((acc, o) => acc + (o.total_amount || 0), 0);
    const total_sales_tips = Math.max(0, Number((total_sales - total_sales_subtotal).toFixed(2)));

    return {
      date: targetDate,
      cashier_session: session,
      total_sales: Number(total_sales.toFixed(2)),
      total_sales_subtotal: Number(total_sales_subtotal.toFixed(2)),
      total_sales_tips: Number(total_sales_tips.toFixed(2)),
      total_orders_closed: closedOrders.length,
      by_payment_method,
      table_orders_detail,
      inventory_alerts
    };
  }

  static closeDailyExpedient(dateStr: string | undefined, userId: string, countedCash?: number, note?: string) {
    const targetDate = dateStr || getLocalDateStr();

    // Os rankings consideram só os pedidos deste expediente (sessão de caixa
    // aberta). Antes somavam toda a história do restaurante.
    const activeSession = this.getActiveSession();
    const scope = activeSession
      ? { sql: 'o.cashier_session_id = @scope', value: activeSession.id }
      : { sql: "date(o.updated_at) = @scope", value: targetDate };

    const topFood = db.prepare(`
      SELECT mi.name, SUM(oi.quantity) as total_qty, SUM(oi.total_price) as total_revenue
      FROM order_items oi
      JOIN menu_items mi ON mi.id = oi.menu_item_id
      JOIN orders o ON o.id = oi.order_id
      WHERE o.status = 'CLOSED' AND oi.status != 'CANCELLED' AND ${scope.sql}
        AND mi.category NOT IN ('Bebidas', 'Drinks do Bar', 'Drinks', 'Bar', 'Bebida')
        AND mi.category NOT LIKE '%Drink%'
        AND mi.category NOT LIKE '%Bebida%'
      GROUP BY mi.id
      ORDER BY total_qty DESC
      LIMIT 1
    `).get({ scope: scope.value }) as { name: string; total_qty: number; total_revenue: number } | undefined;

    const topDrink = db.prepare(`
      SELECT mi.name, SUM(oi.quantity) as total_qty, SUM(oi.total_price) as total_revenue
      FROM order_items oi
      JOIN menu_items mi ON mi.id = oi.menu_item_id
      JOIN orders o ON o.id = oi.order_id
      WHERE o.status = 'CLOSED' AND oi.status != 'CANCELLED' AND ${scope.sql}
        AND (mi.category IN ('Bebidas', 'Drinks do Bar', 'Drinks', 'Bar', 'Bebida') OR mi.category LIKE '%Drink%' OR mi.category LIKE '%Bebida%')
      GROUP BY mi.id
      ORDER BY total_qty DESC
      LIMIT 1
    `).get({ scope: scope.value }) as { name: string; total_qty: number; total_revenue: number } | undefined;

    const topTable = db.prepare(`
      SELECT t.number as table_number, SUM(o.total_amount) as total_revenue
      FROM orders o
      JOIN tables t ON t.id = o.table_id
      WHERE o.status = 'CLOSED' AND ${scope.sql}
      GROUP BY t.id
      ORDER BY total_revenue DESC
      LIMIT 1
    `).get({ scope: scope.value }) as { table_number: number; total_revenue: number } | undefined;

    const topPayment = db.prepare(`
      SELECT p.payment_method, SUM(p.amount) as total_revenue
      FROM payments p
      JOIN orders o ON o.id = p.order_id
      WHERE ${scope.sql}
      GROUP BY p.payment_method
      ORDER BY total_revenue DESC
      LIMIT 1
    `).get({ scope: scope.value }) as { payment_method: PaymentMethod; total_revenue: number } | undefined;

    // Consumo do expediente lido das movimentações de estoque. A baixa já
    // aconteceu na venda: antes este trecho baixava o estoque DE NOVO, e de
    // todos os pedidos fechados da história, a cada fechamento.
    const since = activeSession?.opened_at ?? `${targetDate} 00:00:00`;
    const consumedInventory = InventoryRepository.consumptionSince(since);

    const report = this.getDailyReport(targetDate);

    let cashCheck: { expected_cash: number; counted_cash: number; cash_difference: number } | null = null;
    if (activeSession) {
      if (countedCash === undefined || !Number.isFinite(countedCash) || countedCash < 0) {
        throw new HttpError(400, 'Conte o dinheiro da gaveta e informe o valor para encerrar o caixa.');
      }
      const closed = this.closeSession(activeSession.id, userId, countedCash, note);
      cashCheck = { expected_cash: closed.expected_cash, counted_cash: closed.counted_cash, cash_difference: closed.cash_difference };
    }

    const fullExpedientData = {
      closed_at: new Date().toISOString(),
      report,
      analytics: {
        top_food: topFood || { name: 'Nenhum prato vendido', total_qty: 0, total_revenue: 0 },
        top_drink: topDrink || { name: 'Nenhuma bebida vendida', total_qty: 0, total_revenue: 0 },
        top_table: topTable || { table_number: 0, total_revenue: 0 },
        top_payment: topPayment || { payment_method: 'N/A' as PaymentMethod, total_revenue: 0 }
      },
      inventory_consumed: consumedInventory,
      service_tax_percent: getServiceTaxPercent(),
      cash_check: cashCheck
    };

    const reportTxtResult = generateExpedientReportTxt(fullExpedientData);

    return {
      success: true,
      closed_at: fullExpedientData.closed_at,
      report,
      analytics: fullExpedientData.analytics,
      inventory_consumed: consumedInventory,
      service_tax_percent: fullExpedientData.service_tax_percent,
      cash_check: cashCheck,
      report_file: reportTxtResult.filePath,
      report_text: reportTxtResult.reportContent
    };
  }
}
