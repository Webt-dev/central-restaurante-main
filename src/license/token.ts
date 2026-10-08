import { createPublicKey, verify, KeyObject } from 'node:crypto';

/**
 * Formato da licença: base64url(JSON do payload) + "." + base64url(assinatura Ed25519).
 * Quem assina é o nosso servidor de licenças (chave privada só lá). A central
 * só tem a chave pública: consegue conferir, nunca fabricar uma licença.
 */
export interface LicensePayload {
  /** Identificador do cliente (estabelecimento) no servidor de licenças. */
  clientId: string;
  clientName: string;
  plan: string;
  /** Módulos liberados pelo plano (ex.: "fiscal"). */
  features: string[];
  maxDevices: number;
  /** Fim do período pago (ISO). */
  paidUntil: string;
  /** Fim da carência: paidUntil + 7 dias (ISO). Depois disso o sistema bloqueia. */
  validUntil: string;
  /** Máquina para a qual a licença foi emitida. */
  hwFingerprint: string;
  issuedAt: string;
  /** Hora do servidor na emissão — usada para detectar relógio atrasado. */
  serverTime: string;
  /** true = avaliação (trial) emitida pelo servidor: 7 dias, todos os módulos, sem carência. */
  trial?: boolean;
}

/**
 * Chave pública do servidor de licenças.
 * PRODUÇÃO: gere o par de chaves no servidor (`npm run keys` em license-server/) e cole aqui
 * a chave pública. LICENSE_PUBLIC_KEY no ambiente tem prioridade (testes/homologação).
 */
const EMBEDDED_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAbCCsE87RvKn9I+vZQqIHvFKTDkRT4tY45M4e8eCqfiM=
-----END PUBLIC KEY-----`;

let cachedKey: KeyObject | null = null;

function publicKey(): KeyObject {
  if (!cachedKey) cachedKey = createPublicKey(process.env.LICENSE_PUBLIC_KEY || EMBEDDED_PUBLIC_KEY);
  return cachedKey;
}

/** Só para testes. */
export function resetPublicKeyCache(): void {
  cachedKey = null;
}

/** Confere a assinatura e devolve o payload; null se a licença for falsa ou malformada. */
export function verifyLicense(token: string): LicensePayload | null {
  try {
    const [body, signature] = token.trim().split('.');
    if (!body || !signature) return null;
    const ok = verify(null, Buffer.from(body), publicKey(), Buffer.from(signature, 'base64url'));
    if (!ok) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as LicensePayload;
    if (!payload.clientId || !payload.validUntil || !payload.paidUntil || !payload.hwFingerprint) return null;
    return payload;
  } catch {
    return null;
  }
}
