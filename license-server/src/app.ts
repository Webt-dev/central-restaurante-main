import express, { NextFunction, Request, Response } from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { z } from 'zod';
import type { Db } from './db.js';
import {
  addDays, checkCode, getClient, hashCode, issueToken, listClients, newActivationCode, recordPayment, refundPayment, todayBrt
} from './licenses.js';
import { MercadoPagoApi, MpPayment, verifyMercadoPagoSignature } from './mercadopago.js';

export interface AppConfig {
  db: Db;
  privateKey: KeyObject;
  /** Chave da API administrativa (cabeçalho x-api-key). */
  adminApiKey: string;
  /** Mercado Pago: API (com o access token) e a assinatura secreta do webhook. */
  mercadoPago?: {
    api: MercadoPagoApi;
    webhookSecret: string;
    /** Para onde o cliente volta depois de autorizar a assinatura. */
    backUrl: string;
  };
}

function safeEqual(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Limite simples por IP para a ativação (evita adivinhar código). */
const attempts = new Map<string, { count: number; until: number }>();
function tooManyAttempts(ip: string): boolean {
  const a = attempts.get(ip);
  return Boolean(a && a.count >= 10 && a.until > Date.now());
}
function registerAttempt(ip: string, ok: boolean): void {
  if (ok) return void attempts.delete(ip);
  const a = attempts.get(ip) ?? { count: 0, until: 0 };
  a.count += 1;
  a.until = Date.now() + 15 * 60 * 1000;
  attempts.set(ip, a);
}

const hwSchema = z.string().regex(/^[a-f0-9]{16,64}$/i, 'Identificação da máquina inválida');

export function createApp(cfg: AppConfig) {
  const { db, privateKey } = cfg;
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });

  app.get('/health', (req, res) => res.json({ ok: true }));

  // ---------------------------------------------------------- público

  app.post('/v1/activate', (req, res) => {
    const ip = req.ip ?? '';
    if (tooManyAttempts(ip)) return res.status(429).json({ error: 'Muitas tentativas. Aguarde 15 minutos.' });
    const parsed = z.object({ clientId: z.string().min(3), activationCode: z.string().min(4), hw: hwSchema }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Dados de ativação inválidos.' });
    const { clientId, activationCode, hw } = parsed.data;

    const row = db.prepare('SELECT activation_code_hash FROM clients WHERE id = ?').get(clientId) as { activation_code_hash: string } | undefined;
    const client = getClient(db, clientId);
    const ok = Boolean(row && client && checkCode(activationCode, row.activation_code_hash));
    registerAttempt(ip, ok);
    if (!ok || !client) return res.status(403).json({ error: 'Código do cliente ou código de ativação incorreto.' });
    if (client.status === 'CANCELLED') return res.status(410).json({ error: 'Contrato encerrado. Fale com o suporte.' });

    const existing = db.prepare('SELECT 1 FROM devices WHERE client_id = ? AND hw = ?').get(clientId, hw);
    if (!existing) {
      const count = (db.prepare('SELECT COUNT(*) as c FROM devices WHERE client_id = ?').get(clientId) as { c: number }).c;
      if (count >= client.max_devices) {
        return res.status(409).json({ error: 'Limite de computadores do plano atingido. Peça ao suporte para liberar a máquina antiga.' });
      }
      db.prepare('INSERT INTO devices (client_id, hw) VALUES (?, ?)').run(clientId, hw);
    }
    db.prepare("UPDATE devices SET last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE client_id = ? AND hw = ?").run(clientId, hw);
    res.json({ token: issueToken(db, privateKey, client, hw) });
  });

  // Chamado pela central a cada hora e pelo celular do ADMIN (renovação sem
  // internet na central) — por isso libera CORS só nesta rota de leitura.
  app.options('/v1/licenses/:clientId', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    res.sendStatus(204);
  });
  app.get('/v1/licenses/:clientId', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const hw = hwSchema.safeParse(req.query.hw);
    if (!hw.success) return res.status(400).json({ error: 'Identificação da máquina inválida.' });
    const client = getClient(db, String(req.params.clientId));
    const device = client && db.prepare('SELECT 1 FROM devices WHERE client_id = ? AND hw = ?').get(client.id, hw.data);
    if (!client || !device) return res.status(404).json({ error: 'Este computador não está ativado para este cliente.' });
    db.prepare("UPDATE devices SET last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE client_id = ? AND hw = ?").run(client.id, hw.data);
    res.json({ token: issueToken(db, privateKey, client, hw.data) });
  });

  // ------------------------------------------------- webhook Mercado Pago

  /** Data AAAA-MM-DD no fuso de Brasília a partir de um ISO do Mercado Pago. */
  function brtDate(iso: string | null | undefined): string {
    const t = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(t) ? todayBrt(t) : todayBrt();
  }

  /** Descobre de qual cliente é um pagamento: referência externa, assinatura ou consulta à assinatura. */
  async function resolveClientId(api: MercadoPagoApi, payment: MpPayment, preapprovalId?: string): Promise<string | null> {
    const ref = payment.external_reference;
    if (ref && getClient(db, ref)) return ref;
    const subscription = preapprovalId
      ?? payment.point_of_interaction?.transaction_data?.subscription_id
      ?? (typeof payment.metadata?.preapproval_id === 'string' ? payment.metadata.preapproval_id : undefined);
    if (!subscription) return null;
    const byId = db.prepare('SELECT id FROM clients WHERE mp_preapproval_id = ?').get(subscription) as { id: string } | undefined;
    if (byId) return byId.id;
    const pre = await api.getPreapproval(subscription);
    return pre.external_reference && getClient(db, pre.external_reference) ? pre.external_reference : null;
  }

  async function processPayment(api: MercadoPagoApi, paymentId: string, preapprovalId?: string) {
    const payment = await api.getPayment(paymentId);
    const status = String(payment.status);
    if (status === 'refunded' || status === 'charged_back' || status === 'cancelled') {
      return { refunded: refundPayment(db, String(payment.id)) };
    }
    if (status !== 'approved') return { ignored: true, status };

    const clientId = await resolveClientId(api, payment, preapprovalId);
    if (!clientId) {
      console.warn(`Webhook Mercado Pago: pagamento ${payment.id} sem cliente correspondente.`);
      return { ignored: true, reason: 'cliente não encontrado' };
    }
    return recordPayment(db, {
      clientId,
      gateway: 'mercadopago',
      gatewayPaymentId: String(payment.id),
      amount: Number(payment.transaction_amount) || 0,
      paidDate: brtDate(payment.date_approved ?? payment.date_created)
    });
  }

  /**
   * Mercado Pago → avisos de "payment" e de faturas de assinatura
   * ("subscription_authorized_payment"). O aviso só traz o id: a situação real
   * vem da API. Responde 200 para tópicos sem interesse; erro de consulta
   * responde 500 para o Mercado Pago tentar de novo.
   */
  app.post('/v1/webhooks/mercadopago', async (req, res, next) => {
    try {
      const mp = cfg.mercadoPago;
      if (!mp) return res.status(503).json({ error: 'Mercado Pago não configurado.' });

      const dataId = String(req.query['data.id'] ?? req.body?.data?.id ?? '');
      const valid = verifyMercadoPagoSignature({
        xSignature: req.header('x-signature'),
        xRequestId: req.header('x-request-id'),
        dataId,
        secret: mp.webhookSecret
      });
      if (!valid) return res.status(401).json({ error: 'Assinatura do aviso inválida.' });

      const type = String(req.body?.type ?? req.query.type ?? req.query.topic ?? '');
      if (!dataId) return res.json({ ignored: true });

      if (type === 'payment') return res.json(await processPayment(mp.api, dataId));

      if (type === 'subscription_authorized_payment') {
        const invoice = await mp.api.getAuthorizedPayment(dataId);
        const paymentId = invoice.payment?.id;
        if (!paymentId) return res.json({ ignored: true, reason: 'fatura sem pagamento' });
        return res.json(await processPayment(mp.api, String(paymentId), invoice.preapproval_id));
      }

      res.json({ ignored: true, type });
    } catch (err) {
      next(err);
    }
  });

  // ------------------------------------------------------------- admin

  const admin = express.Router();
  admin.use((req: Request, res: Response, next: NextFunction) => {
    if (!safeEqual(req.header('x-api-key'), cfg.adminApiKey)) return res.status(401).json({ error: 'Não autorizado.' });
    next();
  });

  const clientSchema = z.object({
    name: z.string().trim().min(2).max(120),
    document: z.string().trim().max(20).optional(),
    plan: z.string().trim().min(1).max(40).default('padrao'),
    features: z.array(z.string().max(40)).default([]),
    max_devices: z.number().int().min(1).max(20).default(1),
    /** Até quando já tem direito sem pagar (padrão: 7 dias, como a avaliação). */
    paid_until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
  });

  admin.get('/clients', (req, res) => res.json(listClients(db)));

  admin.post('/clients', (req, res) => {
    const parsed = clientSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues.map(i => i.message).join('; ') });
    const c = parsed.data;
    const id = `cli_${randomBytes(6).toString('hex')}`;
    const code = newActivationCode();
    db.prepare(`
      INSERT INTO clients (id, name, document, plan, features, max_devices, base_paid_until, activation_code_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, c.name, c.document ?? null, c.plan, JSON.stringify(c.features), c.max_devices,
      c.paid_until ?? addDays(todayBrt(), 7), hashCode(code));
    // O código de ativação só aparece agora: guarde e envie ao cliente.
    res.status(201).json({ client: getClient(db, id), activation_code: code });
  });

  admin.patch('/clients/:id', (req, res) => {
    const client = getClient(db, String(req.params.id));
    if (!client) return res.status(404).json({ error: 'Cliente não encontrado.' });
    const parsed = z.object({
      name: z.string().trim().min(2).max(120).optional(),
      plan: z.string().trim().min(1).max(40).optional(),
      features: z.array(z.string().max(40)).optional(),
      max_devices: z.number().int().min(1).max(20).optional(),
      status: z.enum(['ACTIVE', 'CANCELLED']).optional(),
      mp_preapproval_id: z.string().trim().max(60).optional()
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Dados inválidos.' });
    const d = parsed.data;
    db.prepare(`
      UPDATE clients SET name = COALESCE(?, name), plan = COALESCE(?, plan), features = COALESCE(?, features),
        max_devices = COALESCE(?, max_devices), status = COALESCE(?, status), mp_preapproval_id = COALESCE(?, mp_preapproval_id)
      WHERE id = ?
    `).run(d.name ?? null, d.plan ?? null, d.features ? JSON.stringify(d.features) : null, d.max_devices ?? null,
      d.status ?? null, d.mp_preapproval_id ?? null, client.id);
    res.json(getClient(db, client.id));
  });

  admin.post('/clients/:id/activation-code', (req, res) => {
    const client = getClient(db, String(req.params.id));
    if (!client) return res.status(404).json({ error: 'Cliente não encontrado.' });
    const code = newActivationCode();
    db.prepare('UPDATE clients SET activation_code_hash = ? WHERE id = ?').run(hashCode(code), client.id);
    res.json({ activation_code: code });
  });

  /** Pagamento fora do gateway (transferência, dinheiro, cortesia). */
  admin.post('/clients/:id/payments', (req, res) => {
    const client = getClient(db, String(req.params.id));
    if (!client) return res.status(404).json({ error: 'Cliente não encontrado.' });
    const parsed = z.object({
      amount: z.number().min(0),
      months: z.number().int().min(1).max(24).default(1),
      due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      note: z.string().max(200).optional()
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Dados inválidos.' });
    const p = parsed.data;
    // Sem data: mesma regra de ciclo dos pagamentos do Mercado Pago (pago hoje).
    res.status(201).json(recordPayment(db, {
      clientId: client.id,
      gateway: 'manual',
      gatewayPaymentId: `manual_${randomBytes(8).toString('hex')}`,
      amount: p.amount,
      dueDate: p.due_date,
      paidDate: todayBrt(),
      months: p.months,
      note: p.note
    }));
  });

  /**
   * Cria a assinatura mensal do cliente no Mercado Pago e devolve o link para
   * ele autorizar a cobrança recorrente (envie por WhatsApp/e-mail).
   */
  admin.post('/clients/:id/subscription', async (req, res, next) => {
    try {
      const mp = cfg.mercadoPago;
      if (!mp) return res.status(503).json({ error: 'Mercado Pago não configurado.' });
      const client = getClient(db, String(req.params.id));
      if (!client) return res.status(404).json({ error: 'Cliente não encontrado.' });
      const parsed = z.object({
        payer_email: z.string().email('E-mail do pagador inválido'),
        amount: z.number().positive().max(10_000).default(150)
      }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues.map(i => i.message).join('; ') });

      const pre = await mp.api.createPreapproval({
        reason: `Central Restaurante — mensalidade (${client.name})`,
        external_reference: client.id,
        payer_email: parsed.data.payer_email,
        back_url: mp.backUrl,
        amount: parsed.data.amount
      });
      db.prepare('UPDATE clients SET mp_preapproval_id = ? WHERE id = ?').run(pre.id, client.id);
      res.status(201).json({ preapproval_id: pre.id, link: pre.init_point });
    } catch (err) {
      next(err);
    }
  });

  /** Libera a vaga de um computador (troca de máquina). */
  admin.delete('/clients/:id/devices/:hw', (req, res) => {
    const r = db.prepare('DELETE FROM devices WHERE client_id = ? AND hw = ?').run(String(req.params.id), String(req.params.hw));
    res.json({ removed: r.changes });
  });

  app.use('/admin', admin);

  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    res.status(500).json({ error: 'Erro interno.' });
  });

  return app;
}
