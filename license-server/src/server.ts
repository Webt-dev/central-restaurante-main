import fs from 'node:fs';
import path from 'node:path';
import { openDb } from './db.js';
import { createApp } from './app.js';
import { loadPrivateKey } from './licenses.js';
import { createMercadoPagoApi } from './mercadopago.js';
import { createFocusNfseProvider, NfseConfig, processInvoices } from './nfse.js';

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
 *
 *  NFS-e automática (Focus NFe) — opcional; sem NFSE_FOCUS_TOKEN não emite:
 *  NFSE_FOCUS_TOKEN         token da empresa no painel da Focus NFe
 *  NFSE_AMBIENTE            homologacao (padrão) | producao
 *  NFSE_CNPJ_PRESTADOR      CNPJ da nossa empresa
 *  NFSE_CODIGO_MUNICIPIO    IBGE (7 dígitos) do município da empresa
 *  NFSE_CODIGO_TRIBUTACAO   código de tributação nacional do serviço (6 dígitos — contador)
 *  NFSE_OPCAO_SIMPLES       1 não optante | 2 MEI | 3 ME/EPP do Simples (padrão 3)
 *  NFSE_TRIBUTACAO_ISS      padrão 1 (operação tributável)
 *  NFSE_SERIE               série da DPS (padrão 1)
 *  NFSE_DESCRICAO           texto do serviço na nota
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

const nfse: NfseConfig | undefined = process.env.NFSE_FOCUS_TOKEN
  ? {
      provider: createFocusNfseProvider(process.env.NFSE_FOCUS_TOKEN, process.env.NFSE_AMBIENTE === 'producao' ? 'producao' : 'homologacao'),
      cnpjPrestador: required('NFSE_CNPJ_PRESTADOR', process.env.NFSE_CNPJ_PRESTADOR?.replace(/\D/g, ''), 14),
      codigoMunicipio: required('NFSE_CODIGO_MUNICIPIO', process.env.NFSE_CODIGO_MUNICIPIO, 7),
      codigoTributacaoNacional: required('NFSE_CODIGO_TRIBUTACAO', process.env.NFSE_CODIGO_TRIBUTACAO, 6),
      opcaoSimplesNacional: Number(process.env.NFSE_OPCAO_SIMPLES ?? 3),
      tributacaoIss: Number(process.env.NFSE_TRIBUTACAO_ISS ?? 1),
      serieDps: Number(process.env.NFSE_SERIE ?? 1),
      descricao: process.env.NFSE_DESCRICAO ?? 'Licença de uso do sistema Central Restaurante (software como serviço) - mensalidade'
    }
  : undefined;

const db = openDb(process.env.DB_FILE ?? path.join(process.cwd(), 'data', 'licenses.sqlite'));

const app = createApp({
  db,
  privateKey: loadPrivateKey(keyPem),
  adminApiKey: required('ADMIN_API_KEY', process.env.ADMIN_API_KEY, 32),
  mercadoPago: process.env.MP_ACCESS_TOKEN
    ? {
        api: createMercadoPagoApi(process.env.MP_ACCESS_TOKEN),
        webhookSecret: required('MP_WEBHOOK_SECRET', process.env.MP_WEBHOOK_SECRET, 16),
        backUrl: process.env.MP_BACK_URL ?? 'https://www.mercadopago.com.br'
      }
    : undefined,
  nfse
});

// Fila de NFS-e: envia pendentes e consulta as que estão em processamento.
if (nfse) {
  const tick = () => void processInvoices(db, nfse).catch(err => console.error('NFS-e:', err));
  tick();
  setInterval(tick, 2 * 60 * 1000).unref();
}

const port = Number(process.env.PORT) || 8080;
app.listen(port, () => console.log(`Servidor de licenças ouvindo na porta ${port}`));
