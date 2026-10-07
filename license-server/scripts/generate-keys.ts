import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Gera o par de chaves Ed25519 das licenças.
 *  - keys/private.pem: fica SÓ no servidor de licenças (nunca no git nem no app).
 *  - a chave pública impressa abaixo vai para src/license/token.ts da central.
 * Trocar o par invalida todas as licenças já emitidas.
 */
const dir = path.join(process.cwd(), 'keys');
const privateFile = path.join(dir, 'private.pem');
if (fs.existsSync(privateFile) && !process.argv.includes('--force')) {
  console.error('Já existe keys/private.pem. Use --force para substituir (invalida as licenças emitidas).');
  process.exit(1);
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(privateFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
const pub = publicKey.export({ type: 'spki', format: 'pem' }).toString();
fs.writeFileSync(path.join(dir, 'public.pem'), pub);
console.log('Chave privada salva em keys/private.pem. Cole esta chave pública em src/license/token.ts da central:\n');
console.log(pub);
