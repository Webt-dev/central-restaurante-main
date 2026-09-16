import { db } from '../config/database.js';
import { CashRegisterSession, Payment, PaymentMethod, DailyReport } from '../models/types.js';
import { TableRepository } from './TableRepository.js';
import { OrderRepository } from './OrderRepository.js';
import { InventoryRepository } from './InventoryRepository.js';
import { AdminRepository } from './AdminRepository.js';
import { generateReceiptTxt, generatePreBillReceiptTxt } from '../utils/receiptGenerator.js';
import { generateExpedientReportTxt } from '../utils/expedientReportGenerator.js';
import { randomUUID } from 'node:crypto';

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
  const tip = includeTip && percent > 0 ? Number(((subtotal * percent) / 100).toFixed(2)) : 0;
  return { percent, tip, total: Number((subtotal + tip).toFixed(2)) };
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

  static closeSession(sessionId: string, userId: string, finalBalance: number): CashRegisterSession {
    const session = this.getActiveSession();
    if (!session || session.id !== sessionId) {
      throw new Error('Sessão de caixa não encontrada ou já encerrada.');
    }

    db.prepare(`
      UPDATE cashier_sessions
      SET closed_by_id = ?, closed_at = datetime('now', 'localtime'), final_balance = ?, status = 'CLOSED'
      WHERE id = ?
    `).run(userId, finalBalance, sessionId);

    return db.prepare('SELECT * FROM cashier_sessions WHERE id = ?').get(sessionId) as CashRegisterSession;
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
      session = this.openSession(cashierUserId || 'u_caixa', 0);
    }

    const tableBill = OrderRepository.getTableBill(tableId);
    if (!tableBill || tableBill.orders.length === 0) {
      throw new Error('Nenhum pedido aberto encontrado para esta mesa.');
    }

    let totalPaidInInput = 0;
    for (const p of paymentsInput) {
      totalPaidInInput += (p.amount_paid !== undefined ? p.amount_paid : p.amount);
    }

    const subtotal = tableBill.total_amount;
    const { percent, total: requiredTotal } = applyServiceTax(subtotal, includeTip);

    if (totalPaidInInput < requiredTotal - 0.01) {
      throw new Error(
        `O valor pago (R$ ${totalPaidInInput.toFixed(2)}) é menor que o total da conta (R$ ${requiredTotal.toFixed(2)}).`
      );
    }

    const createdPayments: Payment[] = [];
    let totalChangeGiven = 0;

    const processTransaction = db.transaction(() => {
      let remainingBill = requiredTotal;

      for (const p of paymentsInput) {
        const paymentAmount = Math.min(p.amount, remainingBill);
        const amountPaid = p.amount_paid !== undefined ? p.amount_paid : p.amount;
        const change = p.method === 'CASH' && amountPaid > paymentAmount
          ? Number((amountPaid - paymentAmount).toFixed(2))
          : 0;

        totalChangeGiven += change;
        remainingBill -= paymentAmount;

        const paymentId = randomUUID();
        const orderId = tableBill.orders[0]!.id;

        db.prepare(`
          INSERT INTO payments (id, table_id, order_id, cashier_session_id, payment_method, amount, amount_paid, change_given)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(paymentId, tableId, orderId, session!.id, p.method, paymentAmount, amountPaid, change);

        if (p.method === 'CASH') {
          db.prepare('UPDATE cashier_sessions SET total_sales = total_sales + ?, total_cash = total_cash + ? WHERE id = ?').run(paymentAmount, paymentAmount, session!.id);
        } else if (p.method === 'PIX') {
          db.prepare('UPDATE cashier_sessions SET total_sales = total_sales + ?, total_pix = total_pix + ? WHERE id = ?').run(paymentAmount, paymentAmount, session!.id);
        } else {
          db.prepare('UPDATE cashier_sessions SET total_sales = total_sales + ?, total_card = total_card + ? WHERE id = ?').run(paymentAmount, paymentAmount, session!.id);
        }

        createdPayments.push({
          id: paymentId,
          table_id: tableId,
          order_id: orderId,
          cashier_session_id: session!.id,
          payment_method: p.method,
          amount: paymentAmount,
          amount_paid: amountPaid,
          change_given: change,
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
      totalChangeGiven,
      session.opened_by_name,
      includeTip && percent > 0,
      percent
    );

    return {
      payments: createdPayments,
      change_given: totalChangeGiven,
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

  static closeDailyExpedient(dateStr?: string, userId: string = 'u_caixa') {
    const targetDate = dateStr || getLocalDateStr();

    const topFood = db.prepare(`
      SELECT mi.name, SUM(oi.quantity) as total_qty, SUM(oi.total_price) as total_revenue
      FROM order_items oi
      JOIN menu_items mi ON mi.id = oi.menu_item_id
      JOIN orders o ON o.id = oi.order_id
      WHERE o.status = 'CLOSED'
        AND mi.category NOT IN ('Bebidas', 'Drinks do Bar', 'Drinks', 'Bar', 'Bebida')
        AND mi.category NOT LIKE '%Drink%'
        AND mi.category NOT LIKE '%Bebida%'
      GROUP BY mi.id
      ORDER BY total_qty DESC
      LIMIT 1
    `).get() as { name: string; total_qty: number; total_revenue: number } | undefined;

    const topDrink = db.prepare(`
      SELECT mi.name, SUM(oi.quantity) as total_qty, SUM(oi.total_price) as total_revenue
      FROM order_items oi
      JOIN menu_items mi ON mi.id = oi.menu_item_id
      JOIN orders o ON o.id = oi.order_id
      WHERE o.status = 'CLOSED'
        AND (mi.category IN ('Bebidas', 'Drinks do Bar', 'Drinks', 'Bar', 'Bebida') OR mi.category LIKE '%Drink%' OR mi.category LIKE '%Bebida%')
      GROUP BY mi.id
      ORDER BY total_qty DESC
      LIMIT 1
    `).get() as { name: string; total_qty: number; total_revenue: number } | undefined;

    const topTable = db.prepare(`
      SELECT t.number as table_number, SUM(o.total_amount) as total_revenue
      FROM orders o
      JOIN tables t ON t.id = o.table_id
      WHERE o.status = 'CLOSED'
      GROUP BY t.id
      ORDER BY total_revenue DESC
      LIMIT 1
    `).get() as { table_number: number; total_revenue: number } | undefined;

    const topPayment = db.prepare(`
      SELECT payment_method, SUM(amount) as total_revenue
      FROM payments
      GROUP BY payment_method
      ORDER BY total_revenue DESC
      LIMIT 1
    `).get() as { payment_method: PaymentMethod; total_revenue: number } | undefined;

    const consumedInventory = db.prepare(`
      SELECT inv.id, inv.name, inv.unit, SUM(oi.quantity * mii.quantity_required) as total_consumed
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      JOIN menu_item_ingredients mii ON mii.menu_item_id = oi.menu_item_id
      JOIN inventory inv ON inv.id = mii.inventory_id
      WHERE o.status = 'CLOSED'
      GROUP BY inv.id
    `).all() as { id: string; name: string; unit: string; total_consumed: number }[];

    const updateInv = db.prepare(`
      UPDATE inventory
      SET quantity = MAX(0, quantity - ?), updated_at = datetime('now', 'localtime')
      WHERE id = ?
    `);

    for (const item of consumedInventory) {
      updateInv.run(item.total_consumed, item.id);
    }

    const report = this.getDailyReport(targetDate);

    const activeSession = this.getActiveSession();
    if (activeSession) {
      this.closeSession(activeSession.id, userId, activeSession.total_sales);
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
      service_tax_percent: getServiceTaxPercent()
    };

    const reportTxtResult = generateExpedientReportTxt(fullExpedientData);

    return {
      success: true,
      closed_at: fullExpedientData.closed_at,
      report,
      analytics: fullExpedientData.analytics,
      inventory_consumed: consumedInventory,
      service_tax_percent: fullExpedientData.service_tax_percent,
      report_file: reportTxtResult.filePath,
      report_text: reportTxtResult.reportContent
    };
  }
}
