import fs from 'node:fs';
import path from 'node:path';
import { openDb } from './db.js';
import { createApp } from './app.js';
import { loadPrivateKey } from './licenses.js';
import { createMercadoPagoApi } from './mercadopago.js';

/**
 * Variáveis de ambiente:
 *  PORT                     porta HTTP (padrão 8080) — publique atrás de HTTPS
 *  DB_FILE                  banco SQLite (padrão ./data/licenses.sqlite)
 *  LICENSE_PRIVATE_KEY      chave privada Ed25519 em PEM, ou
 *  LICENSE_PRIVATE_KEY_FILE caminho do PEM (padrão ./keys/private.pem)
 *  ADMIN_API_KEY            chave da API /admin (obrigatória, mínimo 32 caracteres)
 *  MP_ACCESS_TOKEN          access token da aplicação no Mercado Pago (produção ou teste)
 *  MP_WEBHOOK_SECRET        "assinatura secreta" do webhook (Suas integrações → Webhooks)
 *  MP_BACK_URL              página para onde o cliente volta após autorizar a assinatura
 */
function required(name: string, value: string | undefined, min = 1): string {
  if (!value || value.length < min) {
    console.error(`Configure ${name}${min > 1 ? ` (mínimo ${min} caracteres)` : ''}.`);
    process.exit(1);
  }
  return value;
}

const keyPem = process.env.LICENSE_PRIVATE_KEY
  ?? fs.readFileSync(process.env.LICENSE_PRIVATE_KEY_FILE ?? path.join(process.cwd(), 'keys', 'private.pem'), 'utf8');

const app = createApp({
  db: openDb(process.env.DB_FILE ?? path.join(process.cwd(), 'data', 'licenses.sqlite')),
  privateKey: loadPrivateKey(keyPem),
  adminApiKey: required('ADMIN_API_KEY', process.env.ADMIN_API_KEY, 32),
  mercadoPago: process.env.MP_ACCESS_TOKEN
    ? {
        api: createMercadoPagoApi(process.env.MP_ACCESS_TOKEN),
        webhookSecret: required('MP_WEBHOOK_SECRET', process.env.MP_WEBHOOK_SECRET, 16),
        backUrl: process.env.MP_BACK_URL ?? 'https://www.mercadopago.com.br'
      }
    : undefined
});

const port = Number(process.env.PORT) || 8080;
app.listen(port, () => console.log(`Servidor de licenças ouvindo na porta ${port}`));
