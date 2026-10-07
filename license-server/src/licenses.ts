import { createPrivateKey, KeyObject, randomBytes, scryptSync, sign, timingSafeEqual } from 'node:crypto';
import type { Db } from './db.js';

/**
 * Regras de licença e cobrança.
 *
 * Vencimento efetivo (paidUntil) = maior entre a data-base do cliente e a
 * cobertura dos pagamentos válidos. A licença dá GRACE_DAYS de carência
 * depois disso (validUntil); passado esse prazo a central bloqueia novos
 * pedidos sozinha, mesmo sem internet.
 */

export const GRACE_DAYS = 7;
const BRT = '-03:00'; // Brasil sem horário de verão desde 2019

export interface Client {
  id: string;
  name: string;
  document: string | null;
  plan: string;
  features: string[];
  max_devices: number;
  base_paid_until: string;
  status: 'ACTIVE' | 'CANCELLED';
  mp_preapproval_id: string | null;
  created_at: string;
}

export function loadPrivateKey(pem: string): KeyObject {
  return createPrivateKey(pem);
}

function rowToClient(r: any): Client {
  return { ...r, features: JSON.parse(r.features) };
}

export function getClient(db: Db, id: string): Client | null {
  const r = db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
  return r ? rowToClient(r) : null;
}

export function listClients(db: Db): (Client & { paid_until: string; devices: number })[] {
  return (db.prepare('SELECT * FROM clients ORDER BY name').all() as any[]).map(r => {
    const c = rowToClient(r);
    const devices = (db.prepare('SELECT COUNT(*) as c FROM devices WHERE client_id = ?').get(c.id) as { c: number }).c;
    return { ...c, paid_until: paidUntil(db, c), devices };
  });
}

/** Soma meses a uma data AAAA-MM-DD (31/01 + 1 mês = 28 ou 29/02). */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const t = new Date(`${date}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}

export function todayBrt(now = Date.now()): string {
  return new Date(now - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function paidUntil(db: Db, client: Client): string {
  const row = db.prepare("SELECT MAX(period_until) as p FROM payments WHERE client_id = ? AND status = 'PAID'").get(client.id) as { p: string | null };
  return row.p && row.p > client.base_paid_until ? row.p : client.base_paid_until;
}

// ----------------------------------------------------------------- códigos

/** Código de ativação legível (sem 0/O/1/I), ex.: K7QX-M2PA-9TRD. */
export function newActivationCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(12);
  const chars = Array.from(bytes, b => alphabet[b % alphabet.length]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}

export function hashCode(code: string): string {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(normalizeCode(code), salt, 32).toString('hex')}`;
}

function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function checkCode(code: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const a = Buffer.from(hash, 'hex');
  const b = scryptSync(normalizeCode(code), salt, 32);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ------------------------------------------------------------------ token

export function issueToken(db: Db, key: KeyObject, client: Client, hw: string, now = Date.now()): string {
  const until = paidUntil(db, client);
  const payload = {
    clientId: client.id,
    clientName: client.name,
    plan: client.plan,
    features: client.features,
    maxDevices: client.max_devices,
    paidUntil: `${until}T23:59:59${BRT}`,
    validUntil: `${addDays(until, GRACE_DAYS)}T23:59:59${BRT}`,
    hwFingerprint: hw,
    issuedAt: new Date(now).toISOString(),
    serverTime: new Date(now).toISOString()
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = sign(null, Buffer.from(body), key).toString('base64url');
  return `${body}.${signature}`;
}

// --------------------------------------------------------------- pagamentos

/**
 * Início do período coberto por um pagamento feito em `paidDate`.
 *  - Pagou antes do vencimento ou dentro da carência: mantém o ciclo
 *    (o período começa no vencimento atual — ninguém ganha nem perde dias).
 *  - Pagou depois de bloqueado: começa um ciclo novo na data do pagamento.
 */
export function cycleStart(currentPaidUntil: string, paidDate: string): string {
  return currentPaidUntil >= addDays(paidDate, -GRACE_DAYS) ? currentPaidUntil : paidDate;
}

/**
 * Registra um pagamento confirmado (idempotente por gatewayPaymentId).
 * Cobertura: `months` meses a partir de `dueDate` (se informado) ou do início
 * de ciclo calculado pela data do pagamento.
 */
export function recordPayment(db: Db, p: {
  clientId: string;
  gateway: string;
  gatewayPaymentId: string;
  amount: number;
  dueDate?: string;
  paidDate?: string;
  months?: number;
  note?: string;
}): { created: boolean; paid_until: string } {
  const client = getClient(db, p.clientId);
  if (!client) throw new Error(`Cliente ${p.clientId} não encontrado.`);
  const already = db.prepare('SELECT 1 FROM payments WHERE gateway_payment_id = ?').get(p.gatewayPaymentId);
  if (already) return { created: false, paid_until: paidUntil(db, client) };
  const start = p.dueDate ?? cycleStart(paidUntil(db, client), p.paidDate ?? todayBrt());
  const periodUntil = addMonths(start, p.months ?? 1);
  const res = db.prepare(`
    INSERT OR IGNORE INTO payments (client_id, gateway, gateway_payment_id, amount, due_date, period_until, note)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(client.id, p.gateway, p.gatewayPaymentId, p.amount, start, periodUntil, p.note ?? null);
  return { created: res.changes > 0, paid_until: paidUntil(db, client) };
}

/** Estorno/chargeback: o pagamento deixa de contar e o vencimento recua. */
export function refundPayment(db: Db, gatewayPaymentId: string): { paid_until: string } | null {
  const row = db.prepare('SELECT client_id FROM payments WHERE gateway_payment_id = ?').get(gatewayPaymentId) as { client_id: string } | undefined;
  if (!row) return null;
  db.prepare("UPDATE payments SET status = 'REFUNDED' WHERE gateway_payment_id = ?").run(gatewayPaymentId);
  return { paid_until: paidUntil(db, getClient(db, row.client_id)!) };
}
