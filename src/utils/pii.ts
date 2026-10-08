/**
 * Máscaras de dados pessoais (LGPD) para logs e trilha de auditoria.
 *
 * Princípio da minimização: log e auditoria precisam provar QUE algo
 * aconteceu, não QUEM é o consumidor. Por isso CPF e e-mail nunca são
 * gravados por inteiro nesses lugares.
 */

// CPF com ou sem pontuação, sem ser pedaço de um número maior (CNPJ, chave de acesso, timestamps).
const CPF_RE = /(?<!\d)(\d{3})\.?(\d{3})\.?(\d{3})-?(\d{2})(?!\d)/g;
const EMAIL_RE = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

/** "123.456.789-09" -> "***.***.***-09" (mantém só o dígito verificador). */
export function maskCpf(value: string): string {
  return value.replace(CPF_RE, (_m, _a, _b, _c, dv) => `***.***.***-${dv}`);
}

/** "maria@exemplo.com" -> "m***@exemplo.com". */
export function maskEmail(value: string): string {
  return value.replace(EMAIL_RE, (_m, first, domain) => `${first}***@${domain}`);
}

/** Aplica todas as máscaras num texto livre. */
export function maskPii(value: string): string {
  return maskEmail(maskCpf(value));
}

const CPF_KEYS = /cpf/i;

/**
 * Copia profunda de um objeto com CPF/e-mail mascarados: qualquer chave que
 * contenha "cpf" tem o valor mascarado por inteiro, e textos soltos passam
 * pelas máscaras de padrão.
 */
export function maskPiiDeep(value: unknown): unknown {
  if (typeof value === 'string') return maskPii(value);
  if (Array.isArray(value)) return value.map(maskPiiDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (CPF_KEYS.test(k) && (typeof v === 'string' || typeof v === 'number')) {
        const digits = String(v).replace(/\D/g, '');
        out[k] = digits.length === 11 ? `***.***.***-${digits.slice(9)}` : '***';
      } else {
        out[k] = maskPiiDeep(v);
      }
    }
    return out;
  }
  return value;
}
