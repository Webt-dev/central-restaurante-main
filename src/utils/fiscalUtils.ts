/**
 * Utilitários fiscais da NFC-e (modelo 65).
 *
 * ATENÇÃO — LEIA ANTES DE USAR EM PRODUÇÃO:
 * Este módulo monta o XML e calcula a chave de acesso, mas NÃO assina
 * digitalmente e NÃO transmite para a SEFAZ. Um documento sem assinatura
 * ICP-Brasil e sem protocolo de autorização NÃO tem valor fiscal.
 * Veja o LEIA-ME para o que falta até a emissão oficial.
 */

import crypto from 'node:crypto';

/** Código da UF conforme tabela do IBGE, usado no início da chave de acesso. */
export const CODIGOS_UF: Record<string, string> = {
  AC: '12', AL: '27', AP: '16', AM: '13', BA: '29', CE: '23', DF: '53',
  ES: '32', GO: '52', MA: '21', MT: '51', MS: '50', MG: '31', PA: '15',
  PB: '25', PR: '41', PE: '26', PI: '22', RJ: '33', RN: '24', RS: '43',
  RO: '11', RR: '14', SC: '42', SP: '35', SE: '28', TO: '17'
};

export function somenteDigitos(valor: string | number | undefined | null): string {
  return String(valor ?? '').replace(/\D/g, '');
}

export function padZeros(valor: string | number, tamanho: number): string {
  return somenteDigitos(valor).padStart(tamanho, '0').slice(-tamanho);
}

/** Escapa caracteres reservados do XML. */
export function escaparXml(texto: string | number | undefined | null): string {
  return String(texto ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Remove acentos e limita o tamanho, como exige o layout da SEFAZ. */
export function limparTexto(texto: string, max: number): string {
  return String(texto ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7E]/g, '')
    .trim()
    .substring(0, max);
}

export function formatarValor(valor: number, casas = 2): string {
  return (Number(valor) || 0).toFixed(casas);
}

/**
 * Dígito verificador da chave de acesso (módulo 11, pesos 2 a 9).
 */
export function calcularDigitoVerificador(chave43: string): string {
  const digitos = somenteDigitos(chave43);
  let soma = 0;
  let peso = 2;

  for (let i = digitos.length - 1; i >= 0; i--) {
    soma += Number(digitos[i]) * peso;
    peso = peso === 9 ? 2 : peso + 1;
  }

  const resto = soma % 11;
  const dv = 11 - resto;
  return dv >= 10 ? '0' : String(dv);
}

export interface DadosChaveAcesso {
  uf: string;
  dataEmissao: Date;
  cnpj: string;
  modelo: string;   // '65' para NFC-e
  serie: number;
  numero: number;
  tipoEmissao: number; // 1 = normal
  codigoNumerico: number;
}

/**
 * Monta a chave de acesso de 44 dígitos:
 * cUF(2) AAMM(4) CNPJ(14) mod(2) serie(3) nNF(9) tpEmis(1) cNF(8) cDV(1)
 */
export function montarChaveAcesso(dados: DadosChaveAcesso): string {
  const cUF = CODIGOS_UF[dados.uf.toUpperCase()] || '35';
  const ano = String(dados.dataEmissao.getFullYear()).slice(-2);
  const mes = padZeros(dados.dataEmissao.getMonth() + 1, 2);

  const chave43 =
    cUF +
    ano + mes +
    padZeros(dados.cnpj, 14) +
    padZeros(dados.modelo, 2) +
    padZeros(dados.serie, 3) +
    padZeros(dados.numero, 9) +
    padZeros(dados.tipoEmissao, 1) +
    padZeros(dados.codigoNumerico, 8);

  return chave43 + calcularDigitoVerificador(chave43);
}

/** Código numérico aleatório (cNF) — não pode ser igual ao número da nota. */
export function gerarCodigoNumerico(numeroNota: number): number {
  let codigo = 0;
  do {
    codigo = crypto.randomInt(0, 99999999);
  } while (codigo === numeroNota);
  return codigo;
}

/** Data/hora no formato exigido (UTC offset), ex.: 2026-09-07T14:32:10-03:00 */
export function formatarDataHoraFiscal(data: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const offsetMin = -data.getTimezoneOffset();
  const sinal = offsetMin >= 0 ? '+' : '-';
  const offH = p(Math.floor(Math.abs(offsetMin) / 60));
  const offM = p(Math.abs(offsetMin) % 60);

  return `${data.getFullYear()}-${p(data.getMonth() + 1)}-${p(data.getDate())}` +
    `T${p(data.getHours())}:${p(data.getMinutes())}:${p(data.getSeconds())}` +
    `${sinal}${offH}:${offM}`;
}

/**
 * QR Code da NFC-e, versão 2.00, modo online.
 *
 * Formato: <URL consulta>?p=chave|versao|tpAmb|cIdToken|cHashQRCode
 * onde cHashQRCode = SHA-1 de "chave|versao|tpAmb|cIdToken" concatenado ao CSC.
 *
 * IMPORTANTE: confira o formato no manual da SEFAZ do seu estado antes de
 * usar em produção — há variações por UF e por versão do layout.
 */
export function gerarQrCodeNfce(params: {
  chaveAcesso: string;
  tipoAmbiente: number; // 1 = producao, 2 = homologacao
  idTokenCsc: string;
  csc: string;
  urlConsulta: string;
}): string {
  const versaoQr = '2';
  const idToken = padZeros(params.idTokenCsc || '1', 6);

  const base = `${params.chaveAcesso}|${versaoQr}|${params.tipoAmbiente}|${idToken}`;
  const hash = crypto
    .createHash('sha1')
    .update(base + (params.csc || ''), 'utf8')
    .digest('hex')
    .toUpperCase();

  const separador = params.urlConsulta.includes('?') ? '&' : '?';
  return `${params.urlConsulta}${separador}p=${base}|${hash}`;
}

/** Validação simples de CNPJ (dígitos verificadores). */
export function validarCnpj(cnpj: string): boolean {
  const c = somenteDigitos(cnpj);
  if (c.length !== 14) return false;
  if (/^(\d)\1{13}$/.test(c)) return false;

  const calc = (base: string, pesos: number[]) => {
    const soma = base.split('').reduce((acc, d, i) => acc + Number(d) * pesos[i]!, 0);
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };

  const d1 = calc(c.substring(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = calc(c.substring(0, 13), [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);

  return Number(c[12]) === d1 && Number(c[13]) === d2;
}

/** Validação simples de CPF (para identificação opcional do consumidor). */
export function validarCpf(cpf: string): boolean {
  const c = somenteDigitos(cpf);
  if (c.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(c)) return false;

  const calc = (qtd: number) => {
    let soma = 0;
    for (let i = 0; i < qtd; i++) soma += Number(c[i]) * (qtd + 1 - i);
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };

  return calc(9) === Number(c[9]) && calc(10) === Number(c[10]);
}

/** Formas de pagamento no código da SEFAZ (tag tPag). */
export const CODIGO_PAGAMENTO_SEFAZ: Record<string, string> = {
  CASH: '01',        // Dinheiro
  CREDIT_CARD: '03', // Cartão de crédito
  DEBIT_CARD: '04',  // Cartão de débito
  PIX: '17'          // Pagamento instantâneo (Pix)
};
