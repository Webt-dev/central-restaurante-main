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
 * Instalação nova sem licença: 7 dias de avaliação LOCAL (funciona offline). Assim que houver
 * internet e os dados do estabelecimento (CNPJ, e-mail, nome), a avaliação é registrada no
 * servidor, que emite uma licença de avaliação presa à máquina: reinstalar ou apagar o banco
 * não dá avaliação nova, e se o servidor disser que ela já foi usada/venceu, a central respeita.
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
  /** A avaliação em uso foi emitida pelo servidor (não é mais só local). */
  trialRegistered: boolean;
  /** Há dados de avaliação aguardando internet para serem registrados no servidor. */
  trialPending: boolean;
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
    enforced,
    trialRegistered: Boolean(payload?.trial),
    trialPending: readPendingTrial() !== null
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

  // Avaliação emitida pelo servidor: sem carência; vencida, bloqueia como o fim da avaliação local.
  if (payload.trial) {
    const end = Date.parse(payload.validUntil);
    if (now < end) {
      const daysLeft = Math.ceil((end - now) / DAY);
      return result('TRIAL', false, `Período de avaliação: ${daysLeft} dia(s) restante(s). Ative a licença em Gestão → Licença.`, { daysLeft });
    }
    return result('TRIAL_EXPIRED', true, 'O período de avaliação terminou. Ative a licença em Gestão → Licença para voltar a abrir mesas e lançar pedidos.');
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
  // Uma avaliação nunca substitui uma licença de verdade (o ADMIN poderia rebaixar a própria licença por engano).
  if (payload.trial && current && !current.trial) {
    throw new HttpError(409, 'Este computador já tem uma licença; a avaliação não pode substituí-la.');
  }
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

interface ServerReply {
  token: string;
  deviceSecret?: string;
}

async function callServer(url: string, init?: RequestInit): Promise<ServerReply> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal, headers: { 'Content-Type': 'application/json', ...init?.headers } });
    const body = (await res.json().catch(() => ({}))) as { token?: string; error?: string; code?: string; deviceSecret?: string };
    if (!res.ok || !body.token) {
      const status = [401, 404, 409, 429].includes(res.status) ? res.status : 400;
      throw new HttpError(status, body.error || `Servidor de licenças respondeu ${res.status}.`, body.code);
    }
    return { token: body.token, deviceSecret: body.deviceSecret };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(503, 'Sem conexão com o servidor de licenças.');
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------- segredo do dispositivo e avaliação
// Arquivos ao lado do banco (a tabela license_state não ganha colunas sem migração).

const DEVICE_FILE = path.join(env.DATA_DIR, '.license-device');
const TRIAL_PENDING_FILE = path.join(env.DATA_DIR, '.license-trial-pending');

function writePrivateFile(file: string, content: string): void {
  fs.mkdirSync(env.DATA_DIR, { recursive: true });
  fs.writeFileSync(file, content, { mode: 0o600 });
}

/**
 * Segredo que o servidor entregou na ativação: sem ele ninguém, só sabendo o código do
 * cliente e a identificação da máquina, consegue baixar a licença. Vale para um cliente só.
 */
export function getDeviceSecret(clientId?: string | null): string | null {
  try {
    const d = JSON.parse(fs.readFileSync(DEVICE_FILE, 'utf8')) as { clientId?: string; secret?: string };
    if (!d.secret || (clientId && d.clientId !== clientId)) return null;
    return d.secret;
  } catch {
    return null;
  }
}

function saveDeviceSecret(clientId: string, secret: string | undefined): void {
  if (secret) writePrivateFile(DEVICE_FILE, JSON.stringify({ clientId, secret }));
}

interface PendingTrial {
  serverUrl: string;
  name: string;
  cnpj: string;
  email: string;
  consent: boolean;
}

function readPendingTrial(): PendingTrial | null {
  try {
    return JSON.parse(fs.readFileSync(TRIAL_PENDING_FILE, 'utf8')) as PendingTrial;
  } catch {
    return null;
  }
}

function clearPendingTrial(): void {
  try {
    fs.rmSync(TRIAL_PENDING_FILE, { force: true });
  } catch {
    // sem arquivo, nada a limpar
  }
}

/** O servidor disse que a avaliação deste computador/CNPJ/e-mail já foi usada: a avaliação local acaba. */
function markLocalTrialUsed(): void {
  const longAgo = new Date(Date.now() - (TRIAL_DAYS + 30) * DAY).toISOString();
  db.prepare("UPDATE license_state SET trial_started_at = ?, updated_at = datetime('now', 'localtime') WHERE id = 1 AND token IS NULL").run(longAgo);
  emitEvent('license:updated');
}

export interface TrialInput {
  name: string;
  cnpj: string;
  email: string;
  consent?: boolean;
  serverUrl?: string;
}

/**
 * Registra a avaliação no servidor de licenças (quando há internet). Sem internet, guarda os
 * dados e segue na avaliação local de 7 dias; o worker tenta de novo a cada hora e, quando o
 * servidor responder, a licença dele passa a valer (inclusive se disser que já foi usada).
 */
export async function registerTrial(input: TrialInput): Promise<{ registered: boolean; status: LicenseStatus }> {
  const current = currentPayload();
  if (current && !current.trial) throw new HttpError(409, 'Este computador já tem uma licença ativada.');

  const r = row();
  const url = input.serverUrl ?? process.env.LICENSE_SERVER_URL ?? r.server_url;
  if (!url) throw new HttpError(400, 'Endereço do servidor de licenças não configurado.');
  const origin = normalizeUrl(url);
  const pending: PendingTrial = {
    serverUrl: origin, name: input.name.trim(), cnpj: input.cnpj.replace(/\D/g, ''), email: input.email.trim(), consent: input.consent === true
  };

  try {
    const { token } = await callServer(`${origin}/v1/trial`, {
      method: 'POST',
      body: JSON.stringify({ hw: machineFingerprint(), cnpj: pending.cnpj, email: pending.email, name: pending.name, consent: pending.consent })
    });
    db.prepare('UPDATE license_state SET server_url = ? WHERE id = 1').run(origin);
    clearPendingTrial();
    const status = installToken(token);
    return { registered: true, status };
  } catch (err) {
    const e = err as HttpError;
    if (e instanceof HttpError && (e.statusCode === 503 || e.statusCode === 429)) {
      // Sem internet (ou servidor ocupado): guarda os dados e mantém a avaliação local.
      writePrivateFile(TRIAL_PENDING_FILE, JSON.stringify(pending));
      return { registered: false, status: getStatus() };
    }
    clearPendingTrial();
    if (e instanceof HttpError && e.statusCode === 409) markLocalTrialUsed();
    throw err;
  }
}

/** Reconciliação: tenta de novo o registro pendente. Chamado pelo worker; nunca lança. */
export async function retryPendingTrial(): Promise<void> {
  const p = readPendingTrial();
  if (!p) return;
  try {
    await registerTrial({ ...p, serverUrl: p.serverUrl });
  } catch {
    // 409 já marcou a avaliação local como usada; outros erros descartam os dados inválidos
  }
}

/** Primeira ativação neste computador: código do cliente + código de ativação (fornecidos por nós). */
export async function activate(serverUrl: string, clientId: string, activationCode: string): Promise<LicenseStatus> {
  const origin = normalizeUrl(serverUrl);
  const { token, deviceSecret } = await callServer(`${origin}/v1/activate`, {
    method: 'POST',
    body: JSON.stringify({ clientId: clientId.trim(), activationCode: activationCode.trim(), hw: machineFingerprint() })
  });
  db.prepare('UPDATE license_state SET server_url = ?, client_id = ? WHERE id = 1').run(origin, clientId.trim());
  saveDeviceSecret(clientId.trim(), deviceSecret);
  clearPendingTrial(); // já é cliente: a avaliação não importa mais
  return installToken(token);
}

/** Busca a licença atualizada (depois de um pagamento). Chamado no boot e a cada hora. */
export async function refresh(): Promise<LicenseStatus> {
  const r = row();
  if (!r.server_url || !r.client_id) throw new HttpError(409, 'Licença ainda não ativada neste computador.');
  if (currentPayload(r)?.trial) throw new HttpError(409, 'Este computador está em avaliação: não há licença para atualizar.');
  try {
    const secret = getDeviceSecret(r.client_id);
    const { token, deviceSecret } = await callServer(
      `${r.server_url}/v1/licenses/${encodeURIComponent(r.client_id)}?hw=${machineFingerprint()}`,
      secret ? { headers: { 'x-device-secret': secret } } : undefined
    );
    // Computador ativado antes do segredo existir: o servidor entrega o segredo na primeira busca.
    saveDeviceSecret(r.client_id, deviceSecret);
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
    if (currentPayload(r)?.trial || !r.token) void retryPendingTrial();
    else if (r.server_url && r.client_id) void refresh().catch(() => undefined);
  };
  void Promise.resolve().then(tick);
  setInterval(() => recordSeenTime(), 10 * 60 * 1000).unref();
  setInterval(tick, 60 * 60 * 1000).unref();
}
