import fs from 'node:fs';
import path from 'node:path';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { db } from '../config/database.js';
import { env } from '../config/env.js';
import { JWT_SECRET } from '../config/secrets.js';
import { HttpError } from '../utils/httpError.js';
import { emitEvent } from '../sockets/socketManager.js';
import { verifyLicense, LicensePayload } from './token.js';
import { machineFingerprint } from './machine.js';

/**
 * Licença de uso e corte por falta de pagamento.
 *
 * Funciona sem internet: a licença assinada traz a própria validade.
 *  - até o vencimento (paidUntil): normal; nos 3 dias antes, aviso;
 *  - do 1º ao 7º dia de atraso: normal, com faixa contando os dias;
 *  - a partir do 8º dia (validUntil): BLOQUEIA abrir mesa e lançar pedido.
 * Mesmo bloqueado continuam liberados: fechar contas abertas, receber,
 * transmitir NFC-e, exportar dados e renovar a licença (ver requireLicense).
 *
 * Instalação nova sem licença: 7 dias de avaliação.
 * Relógio do computador atrasado de propósito: bloqueia até corrigir.
 */

const DAY = 24 * 60 * 60 * 1000;
export const TRIAL_DAYS = 7;
export const NOTICE_DAYS = 3;
/** Tolerância para ajustes normais de relógio (horário de verão, sincronização). */
const CLOCK_TOLERANCE_MS = 6 * 60 * 60 * 1000;
const REFRESH_TIMEOUT_MS = 10_000;

export type LicenseState = 'TRIAL' | 'TRIAL_EXPIRED' | 'ACTIVE' | 'DUE_SOON' | 'GRACE' | 'BLOCKED' | 'INVALID' | 'CLOCK';

export interface LicenseStatus {
  state: LicenseState;
  /** true = não pode abrir mesa nem lançar pedido. */
  blocked: boolean;
  message: string;
  daysLeft?: number;
  daysOverdue?: number;
  daysUntilBlock?: number;
  clientId: string | null;
  clientName: string | null;
  plan: string | null;
  features: string[];
  paidUntil: string | null;
  validUntil: string | null;
  serverUrl: string | null;
  fingerprint: string;
  lastRefreshAt: string | null;
  lastRefreshError: string | null;
  /** false quando LICENSE_ENFORCE=0 (desenvolvimento): mostra o estado, mas não bloqueia. */
  enforced: boolean;
}

interface Row {
  token: string | null;
  client_id: string | null;
  server_url: string | null;
  trial_started_at: string;
  last_seen_ms: number;
  last_refresh_at: string | null;
  last_refresh_error: string | null;
}

function row(): Row {
  return db.prepare('SELECT * FROM license_state WHERE id = 1').get() as Row;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

// --------------------------------------------------- relógio (anti-rollback)

const CLOCK_FILE = path.join(env.DATA_DIR, '.license-clock');

function clockMac(ms: number): string {
  return createHmac('sha256', JWT_SECRET).update(`license-clock:${ms}`).digest('hex');
}

function readClockFile(): number {
  try {
    const [ms, mac] = fs.readFileSync(CLOCK_FILE, 'utf8').trim().split(':');
    const value = Number(ms);
    const expected = Buffer.from(clockMac(value));
    const got = Buffer.from(mac ?? '');
    return expected.length === got.length && timingSafeEqual(expected, got) ? value : 0;
  } catch {
    return 0;
  }
}

/** Maior data já vista nesta instalação (banco e arquivo assinado; vale a maior). */
function lastSeen(): number {
  return Math.max(row().last_seen_ms, readClockFile());
}

/**
 * Registra a hora atual como "já vista". Com trusted (hora do nosso servidor),
 * a referência é corrigida mesmo para trás — corrige um relógio que estava adiantado.
 */
export function recordSeenTime(ms: number = Date.now(), trusted = false): void {
  const value = trusted ? ms : Math.max(lastSeen(), ms);
  db.prepare("UPDATE license_state SET last_seen_ms = ?, updated_at = datetime('now', 'localtime') WHERE id = 1").run(value);
  try {
    fs.mkdirSync(env.DATA_DIR, { recursive: true });
    fs.writeFileSync(CLOCK_FILE, `${value}:${clockMac(value)}`, { mode: 0o600 });
  } catch {
    // sem arquivo, vale o banco
  }
}

// ------------------------------------------------------------------ estado

function currentPayload(r: Row = row()): LicensePayload | null {
  return r.token ? verifyLicense(r.token) : null;
}

export function getStatus(now: number = Date.now()): LicenseStatus {
  const r = row();
  const enforced = process.env.LICENSE_ENFORCE !== '0';
  const fingerprint = machineFingerprint();
  const payload = currentPayload(r);
  const base = {
    clientId: payload?.clientId ?? r.client_id,
    clientName: payload?.clientName ?? null,
    plan: payload?.plan ?? null,
    features: payload?.features ?? [],
    paidUntil: payload?.paidUntil ?? null,
    validUntil: payload?.validUntil ?? null,
    serverUrl: r.server_url,
    fingerprint,
    lastRefreshAt: r.last_refresh_at,
    lastRefreshError: r.last_refresh_error,
    enforced
  };
  const result = (state: LicenseState, blocked: boolean, message: string, extra: Partial<LicenseStatus> = {}): LicenseStatus =>
    ({ ...base, ...extra, state, blocked: blocked && enforced, message });

  if (now < lastSeen() - CLOCK_TOLERANCE_MS) {
    return result('CLOCK', true, 'A data/hora deste computador está atrasada. Corrija o relógio do Windows para voltar a usar o sistema.');
  }

  if (!r.token) {
    const end = Date.parse(r.trial_started_at) + TRIAL_DAYS * DAY;
    if (now < end) {
      const daysLeft = Math.ceil((end - now) / DAY);
      return result('TRIAL', false, `Período de avaliação: ${daysLeft} dia(s) restante(s). Ative a licença em Gestão → Licença.`, { daysLeft });
    }
    return result('TRIAL_EXPIRED', true, 'O período de avaliação terminou. Ative a licença em Gestão → Licença para voltar a abrir mesas e lançar pedidos.');
  }

  if (!payload) {
    return result('INVALID', true, 'A licença instalada é inválida. Atualize a licença em Gestão → Licença.');
  }
  if (payload.hwFingerprint !== fingerprint) {
    return result('INVALID', true, 'Esta licença foi emitida para outro computador. Ative a licença neste computador em Gestão → Licença.');
  }

  const paid = Date.parse(payload.paidUntil);
  const valid = Date.parse(payload.validUntil);

  if (now < paid) {
    const daysLeft = Math.ceil((paid - now) / DAY);
    if (daysLeft <= NOTICE_DAYS) {
      return result('DUE_SOON', false, `A mensalidade vence em ${daysLeft} dia(s) (${formatDate(payload.paidUntil)}).`, { daysLeft });
    }
    return result('ACTIVE', false, `Licença em dia até ${formatDate(payload.paidUntil)}.`, { daysLeft });
  }

  if (now < valid) {
    const daysOverdue = Math.floor((now - paid) / DAY) + 1;
    const daysUntilBlock = Math.ceil((valid - now) / DAY);
    return result('GRACE', false,
      `Mensalidade em atraso há ${daysOverdue} dia(s). Sem o pagamento, o sistema bloqueia novos pedidos em ${daysUntilBlock} dia(s).`,
      { daysOverdue, daysUntilBlock });
  }

  const daysOverdue = Math.floor((now - paid) / DAY) + 1;
  return result('BLOCKED', true,
    'Sistema bloqueado por falta de pagamento: não é possível abrir mesas nem lançar pedidos. Contas abertas podem ser fechadas normalmente.',
    { daysOverdue });
}

/** Módulo liberado pelo plano? Na avaliação, tudo liberado. */
export function hasFeature(feature: string): boolean {
  const st = getStatus();
  if (!st.enforced || st.state === 'TRIAL') return true;
  if (st.blocked || st.state === 'INVALID') return false;
  return st.features.includes(feature);
}

// ------------------------------------------------------------- instalação

/** Instala uma licença (vinda do servidor, do celular do ADMIN ou de arquivo). */
export function installToken(token: string): LicenseStatus {
  const payload = verifyLicense(token);
  if (!payload) throw new HttpError(400, 'Licença inválida: a assinatura não confere.');
  if (payload.hwFingerprint !== machineFingerprint()) {
    throw new HttpError(400, 'Esta licença foi emitida para outro computador.');
  }
  const current = currentPayload();
  if (current && current.clientId === payload.clientId && Date.parse(payload.issuedAt) < Date.parse(current.issuedAt)) {
    throw new HttpError(409, 'Esta licença é mais antiga que a instalada.');
  }

  db.prepare(`
    UPDATE license_state SET token = ?, client_id = ?, last_refresh_error = NULL, updated_at = datetime('now', 'localtime') WHERE id = 1
  `).run(token.trim(), payload.clientId);
  // Instalar só AVANÇA a referência de horário (uma licença antiga não pode "voltar o relógio").
  const serverTime = Date.parse(payload.serverTime);
  if (Number.isFinite(serverTime)) recordSeenTime(serverTime);

  emitEvent('license:updated');
  return getStatus();
}

function normalizeUrl(url: string): string {
  const u = new URL(url.trim());
  if (u.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(u.hostname)) {
    throw new HttpError(400, 'O endereço do servidor de licenças precisa usar https.');
  }
  return u.origin;
}

async function callServer(url: string, init?: RequestInit): Promise<{ token: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal, headers: { 'Content-Type': 'application/json', ...init?.headers } });
    const body = (await res.json().catch(() => ({}))) as { token?: string; error?: string };
    if (!res.ok || !body.token) throw new HttpError(res.status === 404 ? 404 : 400, body.error || `Servidor de licenças respondeu ${res.status}.`);
    return { token: body.token };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(503, 'Sem conexão com o servidor de licenças.');
  } finally {
    clearTimeout(timer);
  }
}

/** Primeira ativação neste computador: código do cliente + código de ativação (fornecidos por nós). */
export async function activate(serverUrl: string, clientId: string, activationCode: string): Promise<LicenseStatus> {
  const origin = normalizeUrl(serverUrl);
  const { token } = await callServer(`${origin}/v1/activate`, {
    method: 'POST',
    body: JSON.stringify({ clientId: clientId.trim(), activationCode: activationCode.trim(), hw: machineFingerprint() })
  });
  db.prepare('UPDATE license_state SET server_url = ?, client_id = ? WHERE id = 1').run(origin, clientId.trim());
  return installToken(token);
}

/** Busca a licença atualizada (depois de um pagamento). Chamado no boot e a cada hora. */
export async function refresh(): Promise<LicenseStatus> {
  const r = row();
  if (!r.server_url || !r.client_id) throw new HttpError(409, 'Licença ainda não ativada neste computador.');
  try {
    const { token } = await callServer(`${r.server_url}/v1/licenses/${encodeURIComponent(r.client_id)}?hw=${machineFingerprint()}`);
    db.prepare("UPDATE license_state SET last_refresh_at = datetime('now', 'localtime') WHERE id = 1").run();
    installToken(token);
    // Licença recém-emitida pelo nosso servidor: a hora dele é a referência correta,
    // inclusive para corrigir um relógio que estava adiantado.
    const serverTime = Date.parse(verifyLicense(token)!.serverTime);
    if (Number.isFinite(serverTime)) recordSeenTime(serverTime, true);
    return getStatus();
  } catch (err) {
    db.prepare('UPDATE license_state SET last_refresh_error = ? WHERE id = 1').run((err as Error).message);
    throw err;
  }
}

export function startLicenseWorker(): void {
  recordSeenTime();
  const tick = () => {
    recordSeenTime();
    const r = row();
    if (r.server_url && r.client_id) void refresh().catch(() => undefined);
  };
  void Promise.resolve().then(tick);
  setInterval(() => recordSeenTime(), 10 * 60 * 1000).unref();
  setInterval(tick, 60 * 60 * 1000).unref();
}
