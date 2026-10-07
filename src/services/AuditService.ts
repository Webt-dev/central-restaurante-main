import { createHash } from 'node:crypto';
import { db } from '../config/database.js';
import type { AuthenticatedRequest } from '../middlewares/authMiddleware.js';

export interface AuditEntry {
  action: string;
  entity?: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  userId?: string | null;
  userName?: string | null;
  role?: string | null;
  ip?: string | null;
}

const GENESIS = '0'.repeat(64);

function toJson(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

/**
 * Registra uma ação sensível na trilha de auditoria (append-only).
 * Cada linha guarda o hash da anterior: editar o histórico quebra a cadeia.
 */
export function audit(entry: AuditEntry): void {
  const last = db.prepare('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1').get() as { hash: string } | undefined;
  const prevHash = last?.hash ?? GENESIS;

  const row = {
    user_id: entry.userId ?? null,
    user_name: entry.userName ?? null,
    role: entry.role ?? null,
    ip: entry.ip ?? null,
    action: entry.action,
    entity: entry.entity ?? null,
    entity_id: entry.entityId ?? null,
    before_json: toJson(entry.before),
    after_json: toJson(entry.after),
    reason: entry.reason ?? null
  };

  const hash = createHash('sha256').update(prevHash).update(JSON.stringify(row)).digest('hex');

  db.prepare(`
    INSERT INTO audit_log (user_id, user_name, role, ip, action, entity, entity_id, before_json, after_json, reason, prev_hash, hash)
    VALUES (@user_id, @user_name, @role, @ip, @action, @entity, @entity_id, @before_json, @after_json, @reason, @prev_hash, @hash)
  `).run({ ...row, prev_hash: prevHash, hash });
}

/** Atalho que preenche quem fez a ação a partir da requisição autenticada. */
export function auditRequest(req: AuthenticatedRequest, entry: Omit<AuditEntry, 'userId' | 'userName' | 'role' | 'ip'>): void {
  audit({
    ...entry,
    userId: req.user?.userId ?? null,
    userName: req.user?.name ?? null,
    role: req.user?.role ?? null,
    ip: req.ip ?? null
  });
}

/** Confere a cadeia de hashes inteira. Retorna o id da primeira linha adulterada, ou null. */
export function verifyAuditChain(): number | null {
  const rows = db.prepare('SELECT * FROM audit_log ORDER BY id ASC').all() as any[];
  let prevHash = GENESIS;
  for (const r of rows) {
    const row = {
      user_id: r.user_id, user_name: r.user_name, role: r.role, ip: r.ip,
      action: r.action, entity: r.entity, entity_id: r.entity_id,
      before_json: r.before_json, after_json: r.after_json, reason: r.reason
    };
    const expected = createHash('sha256').update(prevHash).update(JSON.stringify(row)).digest('hex');
    if (r.prev_hash !== prevHash || r.hash !== expected) return r.id;
    prevHash = r.hash;
  }
  return null;
}
