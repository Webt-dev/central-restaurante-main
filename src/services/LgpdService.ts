import { db } from '../config/database.js';
import { audit } from './AuditService.js';
import { HttpError } from '../utils/httpError.js';
import { somenteDigitos, validarCpf } from '../utils/fiscalUtils.js';
import { maskCpf } from '../utils/pii.js';

/**
 * Direitos do titular (LGPD) e retenção.
 *
 * Onde o CPF do consumidor mora: SÓ no retrato da nota (fiscal_documents.payload_json,
 * campo cpf_consumidor). Pedidos e pagamentos não guardam CPF; chegamos neles
 * pelo checkout_id da nota (= id do primeiro pagamento do fechamento).
 *
 * Regra de ouro: nota que tem ou terá valor fiscal NÃO pode ser anonimizada
 * antes do prazo de guarda (5 anos, CTN art. 195, parágrafo único), amparada
 * na LGPD art. 7º, II (obrigação legal) e art. 16, I.
 */
export const GUARDA_FISCAL_ANOS = 5;
export const MARGEM_RETENCAO_DIAS = 60;

/**
 * Só estas notas nunca foram autorizadas nem estão na fila: não têm valor
 * fiscal e podem ser anonimizadas. PENDENTE e CONTINGENCIA ainda serão
 * transmitidas; CANCELADO foi autorizada antes (o XML e o evento de
 * cancelamento também precisam ser guardados).
 */
const STATUS_ANONIMIZAVEIS = ['REJEITADO', 'ERRO'];

const BASE_LEGAL =
  'Guarda fiscal obrigatória por 5 anos (CTN art. 195, parágrafo único, e legislação do ICMS) - ' +
  'LGPD art. 7º, II (cumprimento de obrigação legal) e art. 16, I. O CPF será anonimizado automaticamente ' +
  `${MARGEM_RETENCAO_DIAS} dias após o fim do prazo.`;

export interface NotaDoTitular {
  id: string;
  serie: number;
  numero: number;
  status: string;
  valor_total: number;
  table_number: number | null;
  created_at: string;
  anonimizavel: boolean;
  motivo_retencao: string | null;
}

function cpfOuErro(cpf: string): string {
  const digits = somenteDigitos(cpf);
  if (digits.length !== 11 || !validarCpf(digits)) throw new HttpError(400, 'CPF inválido.');
  return digits;
}

/** O JSON é gravado por JSON.stringify (sem espaços), então a busca textual é exata. */
function likeCpf(digits: string): string {
  return `%"cpf_consumidor":"${digits}"%`;
}

function motivoRetencao(status: string): string | null {
  if (STATUS_ANONIMIZAVEIS.includes(status)) return null;
  if (status === 'AUTORIZADO' || status === 'CANCELADO') return 'Nota autorizada: guarda fiscal de 5 anos.';
  if (status === 'CONTINGENCIA') return 'Nota em contingência aguarda transmissão à SEFAZ.';
  return 'Nota ainda na fila de emissão.';
}

export function consultarTitular(cpf: string) {
  const digits = cpfOuErro(cpf);
  const docs = db.prepare(`
    SELECT id, checkout_id, serie, numero, status, valor_total, table_number, created_at
    FROM fiscal_documents WHERE payload_json LIKE ? ORDER BY created_at DESC
  `).all(likeCpf(digits)) as (Omit<NotaDoTitular, 'anonimizavel' | 'motivo_retencao'> & { checkout_id: string })[];

  const getPayment = db.prepare('SELECT order_id FROM payments WHERE id = ?');
  const getOrder = db.prepare('SELECT id, status, total_amount, created_at FROM orders WHERE id = ?');
  const pedidos = new Map<string, unknown>();
  for (const d of docs) {
    const pay = getPayment.get(d.checkout_id) as { order_id: string } | undefined;
    const order = pay && getOrder.get(pay.order_id);
    if (order) pedidos.set(pay.order_id, order);
  }

  const notas: NotaDoTitular[] = docs.map(({ checkout_id: _c, ...d }) => ({
    ...d,
    anonimizavel: STATUS_ANONIMIZAVEIS.includes(d.status),
    motivo_retencao: motivoRetencao(d.status)
  }));

  return { cpf: maskCpf(digits), notas, pedidos: [...pedidos.values()], base_legal: BASE_LEGAL };
}

/** Remove o CPF do retrato da nota, deixando marca de quando foi feito. */
function limparPayload(payloadJson: string): string {
  const p = JSON.parse(payloadJson) as Record<string, unknown>;
  delete p.cpf_consumidor;
  p.cpf_anonimizado_em = new Date().toISOString();
  return JSON.stringify(p);
}

export function anonimizarTitular(cpf: string) {
  const digits = cpfOuErro(cpf);
  const docs = db.prepare('SELECT id, numero, serie, status, payload_json FROM fiscal_documents WHERE payload_json LIKE ?')
    .all(likeCpf(digits)) as { id: string; numero: number; serie: number; status: string; payload_json: string }[];
  if (docs.length === 0) throw new HttpError(404, 'Nenhum registro encontrado para este CPF.');

  const anonimizados: string[] = [];
  const recusados: { id: string; serie: number; numero: number; status: string; motivo: string; base_legal: string }[] = [];
  const upd = db.prepare("UPDATE fiscal_documents SET payload_json = ?, updated_at = datetime('now', 'localtime') WHERE id = ?");

  db.transaction(() => {
    for (const d of docs) {
      if (STATUS_ANONIMIZAVEIS.includes(d.status)) {
        upd.run(limparPayload(d.payload_json), d.id);
        anonimizados.push(d.id);
      } else {
        recusados.push({ id: d.id, serie: d.serie, numero: d.numero, status: d.status, motivo: motivoRetencao(d.status)!, base_legal: BASE_LEGAL });
      }
    }
  })();

  if (anonimizados.length === 0) {
    throw new HttpError(409, `Não é possível anonimizar: ${BASE_LEGAL}`, 'LGPD_GUARDA_FISCAL');
  }
  return { anonimizados, recusados };
}

/**
 * Retenção: notas com mais de 5 anos + 60 dias perdem o CPF. Roda todo dia;
 * é idempotente (quem já foi limpo não casa mais com o filtro).
 */
export function executarRetencao(): number {
  const vencidas = db.prepare(`
    SELECT id, payload_json FROM fiscal_documents
    WHERE payload_json LIKE '%"cpf_consumidor"%'
      AND created_at < datetime('now', 'localtime', '-${GUARDA_FISCAL_ANOS} years', '-${MARGEM_RETENCAO_DIAS} days')
  `).all() as { id: string; payload_json: string }[];
  if (vencidas.length === 0) return 0;

  const upd = db.prepare('UPDATE fiscal_documents SET payload_json = ? WHERE id = ?');
  db.transaction(() => {
    for (const v of vencidas) upd.run(limparPayload(v.payload_json), v.id);
  })();

  audit({ action: 'lgpd.retencao', entity: 'fiscal_documents', userName: 'sistema', role: 'SYSTEM', after: { notas_anonimizadas: vencidas.length } });
  console.log(`LGPD: CPF removido de ${vencidas.length} nota(s) fora do prazo de guarda.`);
  return vencidas.length;
}

export function startRetentionWorker(): void {
  const run = () => {
    try {
      executarRetencao();
    } catch (err) {
      console.error('Falha na rotina de retenção LGPD:', (err as Error).message);
    }
  };
  setTimeout(run, 60_000).unref();
  setInterval(run, 24 * 60 * 60 * 1000).unref();
}
