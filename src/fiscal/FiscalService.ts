import { randomUUID } from 'node:crypto';
import { db } from '../config/database.js';
import { HttpError } from '../utils/httpError.js';
import { CODIGOS_UF, CODIGO_PAGAMENTO_SEFAZ, somenteDigitos, validarCnpj, validarCpf } from '../utils/fiscalUtils.js';
import { toCents, toReais } from '../utils/money.js';
import { emitEvent } from '../sockets/socketManager.js';
import { AcbrMonitorProvider } from './AcbrMonitorProvider.js';
import { SimulacaoProvider } from './SimulacaoProvider.js';
import {
  Ambiente, Emitente, FiscalIndisponivelError, FiscalProvider, ItemNfce, NfceInput, ResultadoEmissao, StatusServico
} from './types.js';

/**
 * Módulo fiscal (NFC-e) — OPCIONAL.
 *
 * Vem desligado. O ADMIN liga em Gestão → Módulos depois de preencher a
 * configuração, cadastrar o NCM de todos os produtos e passar no teste de
 * comunicação com a SEFAZ. Desligado, nenhuma nota é emitida e o caixa
 * funciona como antes.
 *
 * Emissão: cada fechamento de conta vira um documento na fila. Se a SEFAZ
 * (ou a internet) estiver fora, a nota sai em contingência offline e é
 * transmitida sozinha depois; o caixa nunca fica travado esperando a SEFAZ.
 */

export type StatusDocumento = 'PENDENTE' | 'AUTORIZADO' | 'CONTINGENCIA' | 'REJEITADO' | 'CANCELADO' | 'ERRO';

export interface FiscalConfig {
  enabled: boolean;
  provider: 'acbr' | 'simulacao';
  acbr_host: string;
  acbr_port: number;
  ambiente: Ambiente;
  serie: number;
  cnpj: string;
  ie: string;
  razao_social: string;
  nome_fantasia: string;
  crt: '' | '1' | '2' | '3' | '4';
  logradouro: string;
  numero: string;
  bairro: string;
  codigo_municipio: string;
  municipio: string;
  uf: string;
  cep: string;
  telefone: string;
  cfop_padrao: string;
  csosn_padrao: string;
  cst_icms_padrao: string;
  cst_pis_cofins_padrao: string;
  origem_padrao: string;
}

export interface DocumentoFiscal {
  id: string;
  checkout_id: string;
  table_number: number | null;
  provider: string;
  ambiente: number;
  serie: number;
  numero: number;
  chave: string | null;
  status: StatusDocumento;
  tp_emis: number;
  valor_total: number;
  protocolo: string | null;
  motivo: string | null;
  tentativas: number;
  contingencia_desde: string | null;
  autorizado_em: string | null;
  cancelado_em: string | null;
  created_at: string;
}

const DEFAULTS: FiscalConfig = {
  enabled: false,
  provider: 'acbr',
  acbr_host: '127.0.0.1',
  acbr_port: 3434,
  ambiente: 2,
  serie: 1,
  cnpj: '', ie: '', razao_social: '', nome_fantasia: '', crt: '',
  logradouro: '', numero: '', bairro: '', codigo_municipio: '', municipio: '', uf: '', cep: '', telefone: '',
  cfop_padrao: '', csosn_padrao: '', cst_icms_padrao: '', cst_pis_cofins_padrao: '', origem_padrao: '0'
};

/** Prazo do cancelamento comum de NFC-e (regra geral; algumas UFs reduzem). */
export const PRAZO_CANCELAMENTO_MIN = 30;
/** A contingência precisa ser transmitida em ~24 h; alertamos bem antes. */
export const ALERTA_CONTINGENCIA_HORAS = 20;

const RETRY_MINUTES = [1, 2, 5, 10, 30];

function now(): string {
  return new Date().toISOString();
}

function localNow(): string {
  return (db.prepare("SELECT datetime('now', 'localtime') as t").get() as { t: string }).t;
}

// ------------------------------------------------------------------ config

export function getConfig(): FiscalConfig {
  const rows = db.prepare('SELECT key, value FROM fiscal_settings').all() as { key: string; value: string }[];
  const map = Object.fromEntries(rows.map(r => [r.key, r.value]));
  const cfg: any = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS) as (keyof FiscalConfig)[]) {
    if (map[key] === undefined) continue;
    const def = DEFAULTS[key];
    cfg[key] = typeof def === 'number' ? Number(map[key]) : typeof def === 'boolean' ? map[key] === 'true' : map[key];
  }
  return cfg as FiscalConfig;
}

export function isEnabled(): boolean {
  const row = db.prepare("SELECT value FROM fiscal_settings WHERE key = 'enabled'").get() as { value: string } | undefined;
  return row?.value === 'true';
}

const EDITABLE: (keyof FiscalConfig)[] = (Object.keys(DEFAULTS) as (keyof FiscalConfig)[]).filter(k => k !== 'enabled');

export function updateConfig(data: Partial<FiscalConfig>): FiscalConfig {
  const upsert = db.prepare(`
    INSERT INTO fiscal_settings (key, value, updated_at) VALUES (?, ?, datetime('now', 'localtime'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  const digits = new Set<keyof FiscalConfig>(['cnpj', 'ie', 'codigo_municipio', 'cep', 'telefone']);
  db.transaction(() => {
    for (const key of EDITABLE) {
      if (data[key] === undefined) continue;
      let value = String(data[key]).trim();
      if (digits.has(key)) value = somenteDigitos(value);
      if (key === 'uf') value = value.toUpperCase();
      upsert.run(key, value);
    }
  })();
  // Mudar emitente/ambiente com o módulo ligado exige passar de novo pela ativação.
  if (isEnabled() && validarConfig().length > 0) setEnabled(false);
  return getConfig();
}

function setEnabled(value: boolean): void {
  db.prepare(`
    INSERT INTO fiscal_settings (key, value, updated_at) VALUES ('enabled', ?, datetime('now', 'localtime'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(value ? 'true' : 'false');
}

export function produtosSemNcm(): { id: string; name: string; category: string }[] {
  return db.prepare(`
    SELECT id, name, category FROM menu_items
    WHERE active = 1 AND archived_at IS NULL AND (ncm IS NULL OR length(ncm) != 8)
    ORDER BY category, name
  `).all() as { id: string; name: string; category: string }[];
}

/** Lista do que falta para poder ligar a emissão. Vazia = pronto. */
export function validarConfig(cfg: FiscalConfig = getConfig()): string[] {
  const p: string[] = [];
  if (!validarCnpj(cfg.cnpj)) p.push('CNPJ do emitente inválido.');
  if (!cfg.ie) p.push('Informe a inscrição estadual.');
  if (!cfg.razao_social) p.push('Informe a razão social.');
  if (!['1', '2', '3', '4'].includes(cfg.crt)) p.push('Escolha o regime tributário (CRT).');
  if (!cfg.logradouro || !cfg.numero || !cfg.bairro || !cfg.municipio) p.push('Complete o endereço do emitente.');
  if (!/^\d{7}$/.test(cfg.codigo_municipio)) p.push('Código do município (IBGE) deve ter 7 números.');
  if (!CODIGOS_UF[cfg.uf]) p.push('UF inválida.');
  if (!/^\d{8}$/.test(cfg.cep)) p.push('CEP deve ter 8 números.');
  if (!Number.isInteger(cfg.serie) || cfg.serie < 1 || cfg.serie > 999) p.push('Série deve ser de 1 a 999.');
  if (cfg.ambiente !== 1 && cfg.ambiente !== 2) p.push('Ambiente inválido.');
  if (cfg.provider === 'simulacao' && cfg.ambiente !== 2) p.push('A simulação só pode ser usada em homologação.');
  if (cfg.provider === 'acbr' && (!cfg.acbr_host || !cfg.acbr_port)) p.push('Informe o endereço e a porta do ACBrMonitor.');
  if (!/^\d{4}$/.test(cfg.cfop_padrao)) p.push('CFOP padrão deve ter 4 números (confirme com o contador).');
  if (cfg.crt === '3') {
    if (!/^\d{2}$/.test(cfg.cst_icms_padrao)) p.push('CST de ICMS padrão deve ter 2 números (regime normal).');
  } else if (cfg.crt) {
    if (!/^\d{3}$/.test(cfg.csosn_padrao)) p.push('CSOSN padrão deve ter 3 números (Simples Nacional).');
  }
  if (!/^\d{2}$/.test(cfg.cst_pis_cofins_padrao)) p.push('CST de PIS/COFINS padrão deve ter 2 números.');
  const semNcm = produtosSemNcm();
  if (semNcm.length) p.push(`${semNcm.length} produto(s) do cardápio sem NCM de 8 números.`);
  return p;
}

// --------------------------------------------------------------- provedor

let providerOverride: FiscalProvider | null = null;

/** Só para testes. */
export function setProviderForTests(provider: FiscalProvider | null): void {
  providerOverride = provider;
}

export function getProvider(cfg: FiscalConfig = getConfig()): FiscalProvider {
  if (providerOverride) return providerOverride;
  if (cfg.provider === 'simulacao') return new SimulacaoProvider();
  return new AcbrMonitorProvider({ host: cfg.acbr_host, port: cfg.acbr_port });
}

export async function testarConexao(): Promise<StatusServico> {
  const cfg = getConfig();
  return getProvider(cfg).statusServico(cfg.ambiente, cfg.uf);
}

export async function ativar(enabled: boolean): Promise<{ enabled: boolean; status?: StatusServico }> {
  if (!enabled) {
    const abertos = (db.prepare("SELECT COUNT(*) as c FROM fiscal_documents WHERE status IN ('PENDENTE', 'CONTINGENCIA', 'ERRO')").get() as { c: number }).c;
    if (abertos > 0) {
      throw new HttpError(409, `Há ${abertos} nota(s) ainda não autorizada(s). Transmita ou resolva antes de desligar a emissão.`);
    }
    setEnabled(false);
    emitEvent('settings:updated');
    return { enabled: false };
  }

  const pendencias = validarConfig();
  if (pendencias.length) throw new HttpError(400, `Ainda falta: ${pendencias.join(' ')}`);
  const status = await testarConexao();
  if (!status.online) throw new HttpError(409, `Teste com a SEFAZ falhou: ${status.motivo}`);
  setEnabled(true);
  emitEvent('settings:updated');
  return { enabled: true, status };
}

// ------------------------------------------------------------- documentos

const DOC_COLUMNS = `id, checkout_id, table_number, provider, ambiente, serie, numero, chave, status, tp_emis,
  valor_total, protocolo, motivo, tentativas, contingencia_desde, autorizado_em, cancelado_em, created_at`;

export function findById(id: string): DocumentoFiscal | null {
  return (db.prepare(`SELECT ${DOC_COLUMNS} FROM fiscal_documents WHERE id = ?`).get(id) as DocumentoFiscal | undefined) ?? null;
}

export function listar(data?: string): DocumentoFiscal[] {
  if (data) {
    return db.prepare(`SELECT ${DOC_COLUMNS} FROM fiscal_documents WHERE date(created_at) = ? ORDER BY created_at DESC`).all(data) as DocumentoFiscal[];
  }
  return db.prepare(`SELECT ${DOC_COLUMNS} FROM fiscal_documents ORDER BY created_at DESC LIMIT 200`).all() as DocumentoFiscal[];
}

export function resumo(): {
  enabled: boolean;
  provider: string;
  ambiente: number;
  por_status: Record<StatusDocumento, number>;
  contingencia_mais_antiga: string | null;
  alerta_contingencia: boolean;
} {
  const cfg = getConfig();
  const rows = db.prepare(`
    SELECT status, COUNT(*) as c FROM fiscal_documents
    WHERE date(created_at) = date('now', 'localtime') OR status IN ('PENDENTE', 'CONTINGENCIA', 'ERRO')
    GROUP BY status
  `).all() as { status: StatusDocumento; c: number }[];
  const por_status = { PENDENTE: 0, AUTORIZADO: 0, CONTINGENCIA: 0, REJEITADO: 0, CANCELADO: 0, ERRO: 0 } as Record<StatusDocumento, number>;
  rows.forEach(r => { por_status[r.status] = r.c; });
  const oldest = db.prepare("SELECT MIN(contingencia_desde) as d FROM fiscal_documents WHERE status = 'CONTINGENCIA'").get() as { d: string | null };
  const alerta = oldest.d ? (Date.now() - Date.parse(oldest.d)) / 3_600_000 >= ALERTA_CONTINGENCIA_HORAS : false;
  return { enabled: cfg.enabled, provider: cfg.provider, ambiente: cfg.ambiente, por_status, contingencia_mais_antiga: oldest.d, alerta_contingencia: alerta };
}

function emitente(cfg: FiscalConfig): Emitente {
  return {
    cnpj: cfg.cnpj, ie: cfg.ie, razao_social: cfg.razao_social, nome_fantasia: cfg.nome_fantasia || cfg.razao_social,
    crt: (cfg.crt || '1') as Emitente['crt'], logradouro: cfg.logradouro, numero: cfg.numero, bairro: cfg.bairro,
    codigo_municipio: cfg.codigo_municipio, municipio: cfg.municipio, uf: cfg.uf, cep: cfg.cep, telefone: cfg.telefone
  };
}

export interface CheckoutFiscal {
  checkoutId: string;
  tableId: string;
  tableNumber: number;
  /** Consumo (sem a taxa de serviço, que não é receita do restaurante — Lei 13.419). */
  itens: { menu_item_id: string; name: string; quantity: number; unit_price: number; total_price: number }[];
  consumo: number;
  pagamentos: { method: string; amount: number }[];
  cpf?: string;
  userId: string;
}

/**
 * Coloca o fechamento de conta na fila fiscal e dispara o envio em segundo
 * plano. Não espera a SEFAZ: o caixa segue atendendo.
 */
export function enfileirarCheckout(checkout: CheckoutFiscal): DocumentoFiscal | null {
  if (!isEnabled()) return null;
  const cfg = getConfig();

  if (checkout.cpf && !validarCpf(checkout.cpf)) throw new HttpError(400, 'CPF do consumidor inválido.');

  const fiscalByItem = db.prepare('SELECT ncm, cfop, cest, origem, csosn, cst_icms, cst_pis_cofins, unidade_fiscal, gtin FROM menu_items WHERE id = ?');
  const itens: ItemNfce[] = checkout.itens.map(i => {
    const f = (fiscalByItem.get(i.menu_item_id) ?? {}) as Record<string, string | null>;
    return {
      codigo: i.menu_item_id,
      descricao: i.name,
      ncm: f.ncm ?? '',
      cfop: f.cfop || cfg.cfop_padrao,
      cest: f.cest || undefined,
      gtin: f.gtin || undefined,
      unidade: f.unidade_fiscal || 'UN',
      quantidade: i.quantity,
      valor_unitario: i.unit_price,
      valor_total: i.total_price,
      origem: f.origem || cfg.origem_padrao || '0',
      ...(cfg.crt === '3' ? { cst_icms: f.cst_icms || cfg.cst_icms_padrao } : { csosn: f.csosn || cfg.csosn_padrao }),
      cst_pis_cofins: f.cst_pis_cofins || cfg.cst_pis_cofins_padrao
    };
  });

  // Pagamentos da nota somam exatamente o consumo (a taxa de serviço fica fora do vNF).
  let restante = toCents(checkout.consumo);
  const pagamentos = checkout.pagamentos
    .map(p => {
      const valor = Math.min(toCents(p.amount), restante);
      restante -= valor;
      return { tpag: CODIGO_PAGAMENTO_SEFAZ[p.method] ?? '99', valor: toReais(valor) };
    })
    .filter(p => p.valor > 0);

  const semNcm = itens.filter(i => !/^\d{8}$/.test(i.ncm)).map(i => i.descricao);
  const id = randomUUID();

  db.transaction(() => {
    const seq = db.prepare('SELECT ultimo_numero FROM fiscal_sequence WHERE serie = ?').get(cfg.serie) as { ultimo_numero: number } | undefined;
    const numero = (seq?.ultimo_numero ?? 0) + 1;
    db.prepare(`
      INSERT INTO fiscal_sequence (serie, ultimo_numero) VALUES (?, ?)
      ON CONFLICT(serie) DO UPDATE SET ultimo_numero = excluded.ultimo_numero
    `).run(cfg.serie, numero);

    const input: NfceInput = {
      ambiente: cfg.ambiente,
      serie: cfg.serie,
      numero,
      emissao: now(),
      tp_emis: 1,
      emitente: emitente(cfg),
      cpf_consumidor: checkout.cpf ? somenteDigitos(checkout.cpf) : undefined,
      itens,
      pagamentos,
      valor_total: checkout.consumo,
      info_complementar: cfg.ambiente === 2 ? 'EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL' : undefined
    };

    db.prepare(`
      INSERT INTO fiscal_documents (id, checkout_id, table_id, table_number, provider, ambiente, serie, numero, status,
        valor_total, payload_json, motivo, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, checkout.checkoutId, checkout.tableId, checkout.tableNumber, cfg.provider, cfg.ambiente, cfg.serie, numero,
      semNcm.length ? 'ERRO' : 'PENDENTE', checkout.consumo, JSON.stringify(input),
      semNcm.length ? `Produto sem NCM: ${semNcm.join(', ')}. Corrija o cadastro e reprocesse.` : null,
      checkout.userId
    );
  })();

  if (!semNcm.length) void processar(id);
  return findById(id);
}

/** Envios em andamento: uma segunda chamada para o mesmo documento espera a primeira. */
const emAndamento = new Map<string, Promise<DocumentoFiscal | null>>();

function agendarNovaTentativa(id: string, tentativas: number, motivo: string, status: StatusDocumento): void {
  const minutos = RETRY_MINUTES[Math.min(tentativas, RETRY_MINUTES.length - 1)]!;
  db.prepare(`
    UPDATE fiscal_documents
    SET status = ?, motivo = ?, tentativas = ?, proxima_tentativa = datetime('now', 'localtime', ?), updated_at = datetime('now', 'localtime')
    WHERE id = ?
  `).run(status, motivo, tentativas, `+${minutos} minutes`, id);
}

function aplicarResultado(id: string, r: ResultadoEmissao, payload: NfceInput, tentativas: number): void {
  if (r.status === 'AUTORIZADO') {
    db.prepare(`
      UPDATE fiscal_documents SET status = 'AUTORIZADO', chave = ?, protocolo = ?, motivo = ?, xml_path = COALESCE(?, xml_path),
        qr_code_url = COALESCE(?, qr_code_url), tentativas = ?, proxima_tentativa = NULL,
        autorizado_em = datetime('now', 'localtime'), payload_json = ?, updated_at = datetime('now', 'localtime')
      WHERE id = ?
    `).run(r.chave, r.protocolo, r.motivo ?? null, r.xml_path ?? null, r.qr_code_url ?? null, tentativas, JSON.stringify(payload), id);
  } else if (r.status === 'CONTINGENCIA') {
    db.prepare(`
      UPDATE fiscal_documents SET status = 'CONTINGENCIA', tp_emis = 9, chave = ?, motivo = ?, xml_path = COALESCE(?, xml_path),
        qr_code_url = COALESCE(?, qr_code_url), tentativas = ?, contingencia_desde = ?, proxima_tentativa = datetime('now', 'localtime', '+1 minutes'),
        payload_json = ?, updated_at = datetime('now', 'localtime')
      WHERE id = ?
    `).run(r.chave, r.motivo ?? 'Emitida em contingência offline.', r.xml_path ?? null, r.qr_code_url ?? null, tentativas,
      payload.contingencia?.desde ?? now(), JSON.stringify(payload), id);
  } else {
    db.prepare(`
      UPDATE fiscal_documents SET status = 'REJEITADO', chave = COALESCE(?, chave), motivo = ?, tentativas = ?, proxima_tentativa = NULL,
        updated_at = datetime('now', 'localtime')
      WHERE id = ?
    `).run(r.chave ?? null, r.motivo, tentativas, id);
  }
}

/** Envia (ou transmite a contingência de) um documento. Nunca lança: o resultado fica gravado no documento. */
export function processar(id: string): Promise<DocumentoFiscal | null> {
  const running = emAndamento.get(id);
  if (running) return running;
  const job = executar(id).finally(() => emAndamento.delete(id));
  emAndamento.set(id, job);
  return job;
}

async function executar(id: string): Promise<DocumentoFiscal | null> {
  {
    const row = db.prepare('SELECT * FROM fiscal_documents WHERE id = ?').get(id) as any;
    if (!row || !['PENDENTE', 'ERRO', 'CONTINGENCIA'].includes(row.status)) return findById(id);
    const payload = JSON.parse(row.payload_json) as NfceInput;
    // Nunca transmite item sem NCM (a SEFAZ rejeitaria e o número seria perdido).
    const semNcm = payload.itens.filter(i => !/^\d{8}$/.test(i.ncm)).map(i => i.descricao);
    if (semNcm.length) {
      db.prepare("UPDATE fiscal_documents SET status = 'ERRO', motivo = ?, updated_at = datetime('now', 'localtime') WHERE id = ?")
        .run(`Produto sem NCM: ${semNcm.join(', ')}. Corrija o cadastro e reprocesse.`, id);
      return findById(id);
    }
    const cfg = getConfig();
    const provider = getProvider(cfg);
    const tentativas = row.tentativas + 1;

    try {
      if (row.status === 'CONTINGENCIA') {
        aplicarResultado(id, await provider.transmitirContingencia(row.chave, payload), payload, tentativas);
      } else {
        try {
          aplicarResultado(id, await provider.emitir({ ...payload, tp_emis: 1 }), { ...payload, tp_emis: 1 }, tentativas);
        } catch (err) {
          if (!(err instanceof FiscalIndisponivelError)) throw err;
          // SEFAZ/internet fora: emite em contingência offline para o cliente sair com a nota.
          const offline: NfceInput = {
            ...payload,
            tp_emis: 9,
            contingencia: { desde: now(), justificativa: `Falha de comunicação com a SEFAZ: ${err.message}`.slice(0, 250) }
          };
          aplicarResultado(id, await provider.emitir(offline), offline, tentativas);
        }
      }
    } catch (err) {
      const motivo = err instanceof Error ? err.message : String(err);
      agendarNovaTentativa(id, tentativas, motivo, row.status === 'CONTINGENCIA' ? 'CONTINGENCIA' : 'ERRO');
    }
    emitEvent('fiscal:updated', { id });
    return findById(id);
  }
}

/** Reenvio manual (ex.: depois de corrigir o NCM de um produto). */
export async function reprocessar(id: string): Promise<DocumentoFiscal | null> {
  const doc = findById(id);
  if (!doc) throw new HttpError(404, 'Documento fiscal não encontrado.');
  if (!['ERRO', 'CONTINGENCIA', 'PENDENTE'].includes(doc.status)) {
    throw new HttpError(409, 'Só notas com erro, pendentes ou em contingência podem ser reenviadas.');
  }
  if (doc.status === 'ERRO') {
    // Recarrega os dados fiscais atuais dos produtos (NCM corrigido etc.).
    const row = db.prepare('SELECT payload_json FROM fiscal_documents WHERE id = ?').get(id) as { payload_json: string };
    const payload = JSON.parse(row.payload_json) as NfceInput;
    const fiscal = db.prepare('SELECT ncm FROM menu_items WHERE id = ?');
    payload.itens = payload.itens.map(i => ({ ...i, ncm: (fiscal.get(i.codigo) as { ncm: string | null } | undefined)?.ncm ?? i.ncm }));
    const semNcm = payload.itens.filter(i => !/^\d{8}$/.test(i.ncm));
    if (semNcm.length) throw new HttpError(400, `Ainda há produto sem NCM: ${semNcm.map(i => i.descricao).join(', ')}.`);
    db.prepare("UPDATE fiscal_documents SET payload_json = ?, status = 'PENDENTE', proxima_tentativa = NULL WHERE id = ?").run(JSON.stringify(payload), id);
  }
  return processar(id);
}

export async function cancelar(id: string, justificativa: string): Promise<DocumentoFiscal | null> {
  const row = db.prepare('SELECT * FROM fiscal_documents WHERE id = ?').get(id) as any;
  if (!row) throw new HttpError(404, 'Documento fiscal não encontrado.');
  if (row.status !== 'AUTORIZADO') throw new HttpError(409, 'Só notas autorizadas podem ser canceladas.');
  const texto = justificativa.trim();
  if (texto.length < 15 || texto.length > 255) throw new HttpError(400, 'A justificativa deve ter de 15 a 255 caracteres.');
  const minutos = (Date.parse(`${localNow().replace(' ', 'T')}`) - Date.parse(`${String(row.autorizado_em).replace(' ', 'T')}`)) / 60_000;
  if (minutos > PRAZO_CANCELAMENTO_MIN) {
    throw new HttpError(409, `O prazo de ${PRAZO_CANCELAMENTO_MIN} minutos para cancelar esta nota acabou. Fale com o contador.`);
  }

  const cfg = getConfig();
  let resultado: { ok: boolean; protocolo?: string; motivo: string };
  try {
    resultado = await getProvider(cfg).cancelar({ chave: row.chave, protocolo: row.protocolo, justificativa: texto, cnpj: cfg.cnpj });
  } catch (err) {
    throw new HttpError(503, `Não foi possível falar com a SEFAZ: ${(err as Error).message}`);
  }
  if (!resultado.ok) throw new HttpError(409, `A SEFAZ recusou o cancelamento: ${resultado.motivo}`);

  db.prepare(`
    UPDATE fiscal_documents SET status = 'CANCELADO', cancelado_em = datetime('now', 'localtime'), cancel_protocolo = ?,
      cancel_justificativa = ?, motivo = ?, updated_at = datetime('now', 'localtime')
    WHERE id = ?
  `).run(resultado.protocolo ?? null, texto, resultado.motivo, id);
  emitEvent('fiscal:updated', { id });
  return findById(id);
}

// ----------------------------------------------------------------- rotina

/** Reenvia pendências e contingências no tempo certo. Roda a cada minuto. */
export async function processarFila(): Promise<void> {
  if (!isEnabled()) return;
  const ids = db.prepare(`
    SELECT id FROM fiscal_documents
    WHERE status IN ('PENDENTE', 'ERRO', 'CONTINGENCIA')
      AND (proxima_tentativa IS NULL OR proxima_tentativa <= datetime('now', 'localtime'))
      AND NOT (status = 'ERRO' AND motivo LIKE 'Produto sem NCM%')
    ORDER BY created_at ASC LIMIT 20
  `).all() as { id: string }[];
  for (const { id } of ids) await processar(id);
}

export function startFiscalWorker(): void {
  setInterval(() => void processarFila().catch(err => console.error('Fila fiscal:', err)), 60_000).unref();
}
