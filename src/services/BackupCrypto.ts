import fs from 'node:fs';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { JWT_SECRET } from '../config/secrets.js';

/**
 * Criptografia de backups (AES-256-GCM, só node:crypto, sem dependência nova).
 *
 * Formato do arquivo .enc:  "CRBK1" | salt(16) | iv(12) | texto cifrado | tag(16)
 *
 * A chave sai de scrypt(senha, salt). A senha é BACKUP_PASSPHRASE, se existir
 * (recomendado: fica com o dono, sobrevive à perda do computador); senão, o
 * segredo da instalação (.jwt-secret). Atenção: com o segredo da instalação,
 * se o disco morrer e o .jwt-secret for junto, o backup espelhado em pendrive/
 * nuvem NÃO abre. Por isso a criptografia é opt-in (BACKUP_ENCRYPT=1).
 *
 * GCM autentica o conteúdo: senha errada ou arquivo adulterado falha na
 * leitura em vez de produzir um banco corrompido silenciosamente.
 */
const MAGIC = Buffer.from('CRBK1');
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const CHUNK = 1024 * 1024;

export const ENCRYPTED_EXT = '.enc';

export function encryptionEnabled(): boolean {
  return process.env.BACKUP_ENCRYPT === '1';
}

export function isEncryptedFile(file: string): boolean {
  return file.endsWith(ENCRYPTED_EXT);
}

function deriveKey(salt: Buffer): Buffer {
  const secret = process.env.BACKUP_PASSPHRASE || JWT_SECRET;
  return scryptSync(secret, salt, 32);
}

/** Cifra `source` em `dest`, em blocos (não carrega o banco inteiro na memória). */
export function encryptFile(source: string, dest: string): void {
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(salt), iv);
  const input = fs.openSync(source, 'r');
  const output = fs.openSync(dest, 'w', 0o600);
  try {
    fs.writeSync(output, Buffer.concat([MAGIC, salt, iv]));
    const buf = Buffer.alloc(CHUNK);
    let read: number;
    while ((read = fs.readSync(input, buf, 0, CHUNK, null)) > 0) {
      fs.writeSync(output, cipher.update(buf.subarray(0, read)));
    }
    fs.writeSync(output, cipher.final());
    fs.writeSync(output, cipher.getAuthTag());
  } finally {
    fs.closeSync(input);
    fs.closeSync(output);
  }
}

/** Decifra `source` em `dest`. Lança erro claro se a senha estiver errada ou o arquivo foi alterado. */
export function decryptFile(source: string, dest: string): void {
  const size = fs.statSync(source).size;
  const headerLen = MAGIC.length + SALT_LEN + IV_LEN;
  if (size < headerLen + TAG_LEN) throw new Error('Arquivo de backup criptografado inválido ou incompleto.');

  const input = fs.openSync(source, 'r');
  try {
    const header = Buffer.alloc(headerLen);
    fs.readSync(input, header, 0, headerLen, 0);
    if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Este arquivo não é um backup criptografado da Central.');
    const salt = header.subarray(MAGIC.length, MAGIC.length + SALT_LEN);
    const iv = header.subarray(MAGIC.length + SALT_LEN);
    const tag = Buffer.alloc(TAG_LEN);
    fs.readSync(input, tag, 0, TAG_LEN, size - TAG_LEN);

    const decipher = createDecipheriv('aes-256-gcm', deriveKey(salt), iv);
    decipher.setAuthTag(tag);

    const output = fs.openSync(dest, 'w', 0o600);
    try {
      const end = size - TAG_LEN;
      let pos = headerLen;
      const buf = Buffer.alloc(CHUNK);
      while (pos < end) {
        const want = Math.min(CHUNK, end - pos);
        const read = fs.readSync(input, buf, 0, want, pos);
        fs.writeSync(output, decipher.update(buf.subarray(0, read)));
        pos += read;
      }
      fs.writeSync(output, decipher.final());
    } catch {
      fs.closeSync(output);
      fs.rmSync(dest, { force: true });
      throw new Error('Não foi possível abrir o backup: senha/segredo da instalação diferente do usado na criação, ou arquivo alterado.');
    }
    fs.closeSync(output);
  } finally {
    fs.closeSync(input);
  }
}
