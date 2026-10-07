/**
 * Contrato entre o sistema e o motor fiscal.
 *
 * O caixa nunca fala com a SEFAZ diretamente: ele monta uma NfceInput e
 * entrega a um FiscalProvider. Hoje há dois provedores:
 *  - AcbrMonitorProvider: o ACBrMonitorPLUS instalado no computador do
 *    restaurante (assina com o certificado A1, transmite, faz contingência e
 *    imprime o DANFE);
 *  - SimulacaoProvider: só em homologação, para demonstração e testes.
 * Trocar por uma API na nuvem no futuro = escrever outro provedor.
 */

export type Ambiente = 1 | 2; // 1 = produção, 2 = homologação

export interface Emitente {
  cnpj: string;
  ie: string;
  razao_social: string;
  nome_fantasia: string;
  /** 1 = Simples Nacional, 2 = Simples (excesso de sublimite), 3 = Regime normal, 4 = MEI */
  crt: '1' | '2' | '3' | '4';
  logradouro: string;
  numero: string;
  bairro: string;
  codigo_municipio: string;
  municipio: string;
  uf: string;
  cep: string;
  telefone: string;
}

export interface ItemNfce {
  codigo: string;
  descricao: string;
  ncm: string;
  cfop: string;
  cest?: string;
  gtin?: string;
  unidade: string;
  quantidade: number;
  valor_unitario: number;
  valor_total: number;
  origem: string;
  /** CSOSN (Simples, CRT 1/2/4) ou CST de ICMS (CRT 3). */
  csosn?: string;
  cst_icms?: string;
  cst_pis_cofins: string;
}

export interface PagamentoNfce {
  /** Código tPag da SEFAZ: 01 dinheiro, 03 crédito, 04 débito, 17 Pix... */
  tpag: string;
  valor: number;
}

export interface NfceInput {
  ambiente: Ambiente;
  serie: number;
  numero: number;
  emissao: string; // ISO
  /** 1 = normal; 9 = contingência offline da NFC-e. */
  tp_emis: 1 | 9;
  contingencia?: { desde: string; justificativa: string };
  emitente: Emitente;
  cpf_consumidor?: string;
  itens: ItemNfce[];
  pagamentos: PagamentoNfce[];
  valor_total: number;
  info_complementar?: string;
}

export type ResultadoEmissao =
  | { status: 'AUTORIZADO'; chave: string; protocolo: string; xml_path?: string; qr_code_url?: string; motivo?: string }
  | { status: 'CONTINGENCIA'; chave: string; xml_path?: string; qr_code_url?: string; motivo?: string }
  | { status: 'REJEITADO'; chave?: string; motivo: string };

export interface StatusServico {
  online: boolean;
  motivo: string;
}

export interface FiscalProvider {
  readonly nome: string;
  /** Conversa com o motor e com a SEFAZ (NFeStatusServico). */
  statusServico(ambiente: Ambiente, uf: string): Promise<StatusServico>;
  emitir(input: NfceInput): Promise<ResultadoEmissao>;
  /** Transmite uma nota emitida em contingência (mesma chave). */
  transmitirContingencia(chave: string, input: NfceInput): Promise<ResultadoEmissao>;
  cancelar(params: { chave: string; protocolo: string; justificativa: string; cnpj: string }): Promise<{ ok: boolean; protocolo?: string; motivo: string }>;
  imprimir?(chave: string): Promise<void>;
}

/** Erro de comunicação (motor desligado, rede, SEFAZ fora): vale tentar de novo / contingência. */
export class FiscalIndisponivelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FiscalIndisponivelError';
  }
}
