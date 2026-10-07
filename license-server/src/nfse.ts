import type { Db } from './db.js';
import { todayBrt } from './licenses.js';

/**
 * NFS-e da mensalidade, emitida automaticamente quando um pagamento é aprovado.
 *
 * Provedor atual: Focus NFe (API de NFS-e Nacional — POST /v2/nfsen?ref=...,
 * consulta em GET /v2/nfsen/{ref}). A Focus assina com o certificado A1 da
 * nossa empresa (cadastrado no painel dela) e transmite ao Ambiente Nacional.
 *
 * Fluxo: pagamento aprovado → nota PENDENTE → enviada (PROCESSANDO) → a rotina
 * consulta até AUTORIZADA ou ERRO. Nada disso atrasa a liberação da licença.
 */

export interface NfseConfig {
  provider: NfseProvider;
  cnpjPrestador: string;
  /** IBGE (7 dígitos) do município da nossa empresa. */
  codigoMunicipio: string;
  /** Código de tributação nacional do serviço (6 dígitos) — definido pelo contador. */
  codigoTributacaoNacional: string;
  /** 1 = não optante, 2 = MEI, 3 = ME/EPP do Simples (conforme tabela da NFS-e Nacional). */
  opcaoSimplesNacional: number;
  /** Tributação do ISS (1 = operação tributável). */
  tributacaoIss: number;
  serieDps: number;
  descricao: string;
}

export type ResultadoNfse =
  | { status: 'processando' }
  | { status: 'autorizada'; numero?: string; url?: string; urlDanfse?: string }
  | { status: 'erro'; mensagem: string };

export interface DadosNfse {
  ref: string;
  numeroDps: number;
  dataEmissao: string;
  dataCompetencia: string;
  valor: number;
  tomadorCnpj?: string;
  tomadorCpf?: string;
  cfg: NfseConfig;
}

export interface NfseProvider {
  emitir(d: DadosNfse): Promise<ResultadoNfse>;
  consultar(ref: string): Promise<ResultadoNfse>;
}

// ------------------------------------------------------------- Focus NFe

export function createFocusNfseProvider(token: string, ambiente: 'producao' | 'homologacao', fetchImpl: typeof fetch = fetch): NfseProvider {
  const base = ambiente === 'producao' ? 'https://api.focusnfe.com.br' : 'https://homologacao.focusnfe.com.br';
  const auth = `Basic ${Buffer.from(`${token}:`).toString('base64')}`;

  function parse(body: any): ResultadoNfse {
    const status = String(body?.status ?? '');
    if (status === 'autorizado') {
      return { status: 'autorizada', numero: body.numero ? String(body.numero) : undefined, url: body.url, urlDanfse: body.url_danfse };
    }
    if (status === 'processando_autorizacao') return { status: 'processando' };
    const erros = Array.isArray(body?.erros) ? body.erros.map((e: any) => `${e.codigo ?? ''} ${e.mensagem ?? ''}`.trim()).join('; ') : '';
    return { status: 'erro', mensagem: erros || body?.mensagem || `Situação inesperada: ${status || 'sem status'}` };
  }

  return {
    async emitir(d) {
      const c = d.cfg;
      const res = await fetchImpl(`${base}/v2/nfsen?ref=${encodeURIComponent(d.ref)}`, {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          data_emissao: d.dataEmissao,
          data_competencia: d.dataCompetencia,
          serie_dps: c.serieDps,
          numero_dps: d.numeroDps,
          emitente_dps: 1,
          codigo_municipio_emissora: Number(c.codigoMunicipio),
          codigo_municipio_prestacao: Number(c.codigoMunicipio),
          cnpj_prestador: c.cnpjPrestador,
          codigo_opcao_simples_nacional: c.opcaoSimplesNacional,
          ...(d.tomadorCnpj ? { cnpj_tomador: d.tomadorCnpj } : {}),
          ...(d.tomadorCpf ? { cpf_tomador: d.tomadorCpf } : {}),
          codigo_tributacao_nacional_iss: c.codigoTributacaoNacional,
          descricao_servico: c.descricao,
          valor_servico: d.valor,
          tributacao_iss: c.tributacaoIss
        })
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 202 || res.status === 200 || res.status === 201) return parse(body);
      if (res.status >= 500) throw new Error(`Focus NFe ${res.status}`);
      return { status: 'erro', mensagem: `${body?.codigo ?? res.status} ${body?.mensagem ?? ''}`.trim() };
    },
    async consultar(ref) {
      const res = await fetchImpl(`${base}/v2/nfsen/${encodeURIComponent(ref)}`, { headers: { Authorization: auth } });
      const body = await res.json().catch(() => ({}));
      if (res.status >= 500) throw new Error(`Focus NFe ${res.status}`);
      return parse(body);
    }
  };
}

// ---------------------------------------------------------------- fila

export function ensureNfseSchema(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_id INTEGER NOT NULL UNIQUE REFERENCES payments(id),
      client_id TEXT NOT NULL REFERENCES clients(id),
      ref TEXT NOT NULL UNIQUE,
      numero_dps INTEGER NOT NULL,
      valor REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDENTE'
        CHECK (status IN ('PENDENTE', 'PROCESSANDO', 'AUTORIZADA', 'ERRO', 'CANCELAR')),
      numero TEXT,
      url TEXT,
      url_danfse TEXT,
      erro TEXT,
      tentativas INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS nfse_sequence (serie INTEGER PRIMARY KEY, ultimo INTEGER NOT NULL DEFAULT 0);
  `);
}

/** Cria a nota de um pagamento (idempotente). Pagamento de valor zero (cortesia) não gera nota. */
export function enqueueInvoice(db: Db, cfg: NfseConfig, gatewayPaymentId: string): number | null {
  const pay = db.prepare('SELECT id, client_id, amount FROM payments WHERE gateway_payment_id = ?').get(gatewayPaymentId) as
    { id: number; client_id: string; amount: number } | undefined;
  if (!pay || pay.amount <= 0) return null;
  const existing = db.prepare('SELECT id FROM invoices WHERE payment_id = ?').get(pay.id) as { id: number } | undefined;
  if (existing) return existing.id;

  return db.transaction(() => {
    const seq = db.prepare('SELECT ultimo FROM nfse_sequence WHERE serie = ?').get(cfg.serieDps) as { ultimo: number } | undefined;
    const numero = (seq?.ultimo ?? 0) + 1;
    db.prepare('INSERT INTO nfse_sequence (serie, ultimo) VALUES (?, ?) ON CONFLICT(serie) DO UPDATE SET ultimo = excluded.ultimo').run(cfg.serieDps, numero);
    const r = db.prepare('INSERT INTO invoices (payment_id, client_id, ref, numero_dps, valor) VALUES (?, ?, ?, ?, ?)')
      .run(pay.id, pay.client_id, `mensalidade-${pay.id}`, numero, pay.amount);
    return Number(r.lastInsertRowid);
  })();
}

function nowBrtIso(): string {
  // ISO com fuso de Brasília, formato aceito pela Focus (ex.: 2026-10-07T10:30:00-0300).
  const d = new Date(Date.now() - 3 * 60 * 60 * 1000);
  return `${d.toISOString().slice(0, 19)}-0300`;
}

const MAX_TENTATIVAS = 8;

/** Envia pendentes e consulta as que estão processando. Roda no boot e periodicamente. */
export async function processInvoices(db: Db, cfg: NfseConfig): Promise<void> {
  const rows = db.prepare(`
    SELECT i.*, c.document FROM invoices i JOIN clients c ON c.id = i.client_id
    WHERE i.status IN ('PENDENTE', 'PROCESSANDO') AND i.tentativas < ?
    ORDER BY i.id LIMIT 20
  `).all(MAX_TENTATIVAS) as any[];

  for (const inv of rows) {
    let result: ResultadoNfse;
    try {
      if (inv.status === 'PENDENTE') {
        const doc = String(inv.document ?? '').replace(/\D/g, '');
        result = await cfg.provider.emitir({
          ref: inv.ref,
          numeroDps: inv.numero_dps,
          dataEmissao: nowBrtIso(),
          dataCompetencia: todayBrt(),
          valor: inv.valor,
          tomadorCnpj: doc.length === 14 ? doc : undefined,
          tomadorCpf: doc.length === 11 ? doc : undefined,
          cfg
        });
      } else {
        result = await cfg.provider.consultar(inv.ref);
      }
    } catch (err) {
      // Falha de comunicação: tenta de novo na próxima rodada.
      db.prepare("UPDATE invoices SET tentativas = tentativas + 1, erro = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?")
        .run((err as Error).message, inv.id);
      continue;
    }

    if (result.status === 'autorizada') {
      db.prepare(`UPDATE invoices SET status = 'AUTORIZADA', numero = ?, url = ?, url_danfse = ?, erro = NULL,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
        .run(result.numero ?? null, result.url ?? null, result.urlDanfse ?? null, inv.id);
    } else if (result.status === 'processando') {
      db.prepare("UPDATE invoices SET status = 'PROCESSANDO', tentativas = tentativas + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(inv.id);
    } else {
      db.prepare("UPDATE invoices SET status = 'ERRO', erro = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(result.mensagem, inv.id);
    }
  }
}

/** Estorno de pagamento com nota autorizada: marca para cancelamento manual no painel da Focus/Emissor Nacional. */
export function flagInvoiceForCancellation(db: Db, gatewayPaymentId: string): void {
  db.prepare(`
    UPDATE invoices SET status = 'CANCELAR', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE status = 'AUTORIZADA' AND payment_id = (SELECT id FROM payments WHERE gateway_payment_id = ?)
  `).run(gatewayPaymentId);
}
