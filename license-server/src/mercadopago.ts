import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Integração com o Mercado Pago (assinaturas / preapproval).
 *
 * Fluxo:
 *  1. Criamos a assinatura mensal do cliente (POST /preapproval) com
 *     external_reference = id do cliente aqui. O Mercado Pago devolve um link
 *     (init_point) que o cliente abre para autorizar a cobrança recorrente.
 *  2. A cada cobrança, o Mercado Pago chama nosso webhook. O aviso traz só o
 *     id do recurso: buscamos o pagamento na API (nunca confiamos no corpo).
 *  3. Pagamento aprovado estende a licença; estornado/chargeback recua.
 *
 * Pontos a validar no sandbox antes de produção: tópicos exatos enviados para
 * assinaturas na conta (payment e/ou subscription_authorized_payment) e se a
 * assinatura aceita Pix Automático ou só cartão/Pix avulso.
 */

const API_BASE = 'https://api.mercadopago.com';

export interface MpPayment {
  id: number | string;
  status: string; // approved, pending, in_process, rejected, cancelled, refunded, charged_back
  transaction_amount: number;
  external_reference?: string | null;
  date_approved?: string | null;
  date_created?: string;
  metadata?: Record<string, unknown> | null;
  point_of_interaction?: { transaction_data?: { subscription_id?: string | null } | null } | null;
}

export interface MpAuthorizedPayment {
  id: number | string;
  preapproval_id?: string;
  external_reference?: string | null;
  transaction_amount?: number;
  payment?: { id?: number | string | null; status?: string | null } | null;
}

export interface MpPreapproval {
  id: string;
  status?: string;
  external_reference?: string | null;
  init_point?: string;
}

export interface MercadoPagoApi {
  getPayment(id: string): Promise<MpPayment>;
  getAuthorizedPayment(id: string): Promise<MpAuthorizedPayment>;
  getPreapproval(id: string): Promise<MpPreapproval>;
  createPreapproval(body: {
    reason: string;
    external_reference: string;
    payer_email: string;
    back_url: string;
    amount: number;
  }): Promise<MpPreapproval>;
}

export class MercadoPagoError extends Error {}

export function createMercadoPagoApi(accessToken: string, fetchImpl: typeof fetch = fetch, base = API_BASE): MercadoPagoApi {
  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetchImpl(`${base}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        ...(init?.method === 'POST' ? { 'X-Idempotency-Key': `${path}:${Date.now()}` } : {}),
        ...init?.headers
      }
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new MercadoPagoError(`Mercado Pago ${res.status} em ${path}: ${(body as any)?.message ?? ''}`.trim());
    return body as T;
  }

  return {
    getPayment: id => call<MpPayment>(`/v1/payments/${encodeURIComponent(id)}`),
    getAuthorizedPayment: id => call<MpAuthorizedPayment>(`/authorized_payments/${encodeURIComponent(id)}`),
    getPreapproval: id => call<MpPreapproval>(`/preapproval/${encodeURIComponent(id)}`),
    createPreapproval: b => call<MpPreapproval>('/preapproval', {
      method: 'POST',
      body: JSON.stringify({
        reason: b.reason,
        external_reference: b.external_reference,
        payer_email: b.payer_email,
        back_url: b.back_url,
        status: 'pending',
        auto_recurring: { frequency: 1, frequency_type: 'months', transaction_amount: b.amount, currency_id: 'BRL' }
      })
    })
  };
}

/**
 * Valida o cabeçalho x-signature ("ts=...,v1=...") do Mercado Pago.
 * Manifesto: "id:{data.id};request-id:{x-request-id};ts:{ts};" — partes
 * ausentes são omitidas; data.id alfanumérico vai em minúsculas.
 * HMAC-SHA256 em hexadecimal com a "assinatura secreta" do webhook.
 */
export function verifyMercadoPagoSignature(params: {
  xSignature: string | undefined;
  xRequestId: string | undefined;
  dataId: string | undefined;
  secret: string;
  /** Recusa avisos com carimbo de hora muito antigo (reenvio malicioso). */
  maxAgeSeconds?: number;
  now?: number;
}): boolean {
  const { xSignature, xRequestId, secret } = params;
  if (!xSignature || !secret) return false;

  const parts = Object.fromEntries(
    xSignature.split(',').map(p => p.split('=').map(s => s.trim()) as [string, string])
  );
  const ts = parts.ts;
  const v1 = parts.v1;
  if (!ts || !v1) return false;

  if (params.maxAgeSeconds) {
    const tsMs = Number(ts) * (ts.length > 11 ? 1 : 1000);
    if (!Number.isFinite(tsMs) || Math.abs((params.now ?? Date.now()) - tsMs) > params.maxAgeSeconds * 1000) return false;
  }

  let dataId = params.dataId ?? '';
  if (/[a-z]/i.test(dataId)) dataId = dataId.toLowerCase();

  let manifest = '';
  if (dataId) manifest += `id:${dataId};`;
  if (xRequestId) manifest += `request-id:${xRequestId};`;
  manifest += `ts:${ts};`;

  const expected = Buffer.from(createHmac('sha256', secret).update(manifest).digest('hex'));
  const received = Buffer.from(v1);
  return expected.length === received.length && timingSafeEqual(expected, received);
}
