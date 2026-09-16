/**
 * Montagem do XML da NFC-e (modelo 65, layout 4.00).
 *
 * O XML gerado aqui é COMPLETO em estrutura, porém NÃO ASSINADO.
 * Para ter valor fiscal ele precisa, obrigatoriamente:
 *   1. ser assinado com certificado digital ICP-Brasil (A1 ou A3);
 *   2. ser transmitido ao webservice da SEFAZ do estado;
 *   3. receber o protocolo de autorização de uso.
 *
 * Enquanto isso não acontece, trate o arquivo como um rascunho técnico e
 * um registro interno de conferência — nunca como documento fiscal.
 */

import {
  escaparXml, limparTexto, formatarValor, padZeros, somenteDigitos,
  montarChaveAcesso, gerarCodigoNumerico, formatarDataHoraFiscal,
  gerarQrCodeNfce, CODIGO_PAGAMENTO_SEFAZ, CODIGOS_UF
} from '../utils/fiscalUtils.js';

export interface ConfigFiscal {
  cnpj: string;
  inscricao_estadual: string;
  razao_social: string;
  nome_fantasia: string;
  logradouro: string;
  numero_endereco: string;
  bairro: string;
  codigo_municipio: string;
  nome_municipio: string;
  uf: string;
  cep: string;
  telefone: string;
  regime_tributario: string; // '1' Simples, '2' Simples excesso, '3' Regime normal
  serie_nfce: number;
  ambiente: number;          // 1 producao, 2 homologacao
  csc: string;
  csc_id: string;
  url_consulta: string;
  cfop_padrao: string;
  csosn_padrao: string;
  cst_pis_cofins: string;
}

export interface ItemFiscal {
  codigo: string;
  descricao: string;
  ncm: string;
  cfop: string;
  cest?: string;
  unidade: string;
  quantidade: number;
  valorUnitario: number;
  valorTotal: number;
  origem: string;
  csosn?: string;
  cst_icms?: string;
  aliquota_icms?: number;
}

export interface PagamentoFiscal {
  metodo: string;
  valor: number;
}

export interface DadosNfce {
  numero: number;
  dataEmissao: Date;
  itens: ItemFiscal[];
  pagamentos: PagamentoFiscal[];
  valorTotal: number;
  troco: number;
  cpfConsumidor?: string;
  infoComplementar?: string;
}

export interface ResultadoXml {
  chaveAcesso: string;
  xml: string;
  qrCode: string;
  urlConsulta: string;
  numero: number;
  serie: number;
}

export function construirXmlNfce(config: ConfigFiscal, dados: DadosNfce): ResultadoXml {
  const cnpjLimpo = somenteDigitos(config.cnpj);
  const codigoNumerico = gerarCodigoNumerico(dados.numero);
  const cUF = CODIGOS_UF[config.uf.toUpperCase()] || '35';

  const chaveAcesso = montarChaveAcesso({
    uf: config.uf,
    dataEmissao: dados.dataEmissao,
    cnpj: cnpjLimpo,
    modelo: '65',
    serie: config.serie_nfce,
    numero: dados.numero,
    tipoEmissao: 1,
    codigoNumerico
  });

  const dhEmi = formatarDataHoraFiscal(dados.dataEmissao);

  // Em homologação o layout exige esta razão social fixa no destinatário/emitente
  // de teste. Mantemos o nome real do emitente, mas marcamos o ambiente.
  const ambiente = Number(config.ambiente) === 1 ? 1 : 2;

  // ------------------------------------------------------------- Identificação
  const ide = `
    <ide>
      <cUF>${cUF}</cUF>
      <cNF>${padZeros(codigoNumerico, 8)}</cNF>
      <natOp>VENDA AO CONSUMIDOR</natOp>
      <mod>65</mod>
      <serie>${config.serie_nfce}</serie>
      <nNF>${dados.numero}</nNF>
      <dhEmi>${dhEmi}</dhEmi>
      <tpNF>1</tpNF>
      <idDest>1</idDest>
      <cMunFG>${padZeros(config.codigo_municipio, 7)}</cMunFG>
      <tpImp>4</tpImp>
      <tpEmis>1</tpEmis>
      <cDV>${chaveAcesso.slice(-1)}</cDV>
      <tpAmb>${ambiente}</tpAmb>
      <finNFe>1</finNFe>
      <indFinal>1</indFinal>
      <indPres>1</indPres>
      <procEmi>0</procEmi>
      <verProc>CentralRestaurante-1.5.0</verProc>
    </ide>`;

  // ------------------------------------------------------------------ Emitente
  const emit = `
    <emit>
      <CNPJ>${cnpjLimpo}</CNPJ>
      <xNome>${escaparXml(limparTexto(config.razao_social, 60))}</xNome>
      <xFant>${escaparXml(limparTexto(config.nome_fantasia || config.razao_social, 60))}</xFant>
      <enderEmit>
        <xLgr>${escaparXml(limparTexto(config.logradouro, 60))}</xLgr>
        <nro>${escaparXml(limparTexto(config.numero_endereco || 'S/N', 60))}</nro>
        <xBairro>${escaparXml(limparTexto(config.bairro, 60))}</xBairro>
        <cMun>${padZeros(config.codigo_municipio, 7)}</cMun>
        <xMun>${escaparXml(limparTexto(config.nome_municipio, 60))}</xMun>
        <UF>${config.uf.toUpperCase()}</UF>
        <CEP>${padZeros(config.cep, 8)}</CEP>
        <cPais>1058</cPais>
        <xPais>BRASIL</xPais>
        ${config.telefone ? `<fone>${somenteDigitos(config.telefone)}</fone>` : ''}
      </enderEmit>
      <IE>${somenteDigitos(config.inscricao_estadual)}</IE>
      <CRT>${config.regime_tributario || '1'}</CRT>
    </emit>`;

  // --------------------------------------------------------------- Destinatário
  // Na NFC-e o consumidor é opcional ("nota sem identificação").
  const cpf = somenteDigitos(dados.cpfConsumidor || '');
  const dest = cpf
    ? `
    <dest>
      <CPF>${cpf}</CPF>
      <indIEDest>9</indIEDest>
    </dest>`
    : '';

  // ---------------------------------------------------------------------- Itens
  let totalProdutos = 0;
  const detXml = dados.itens.map((item, idx) => {
    totalProdutos += item.valorTotal;

    const tributacaoIcms = config.regime_tributario === '3'
      ? `
          <ICMS60>
            <orig>${item.origem || '0'}</orig>
            <CST>${item.cst_icms || '60'}</CST>
          </ICMS60>`
      : `
          <ICMSSN102>
            <orig>${item.origem || '0'}</orig>
            <CSOSN>${item.csosn || config.csosn_padrao || '102'}</CSOSN>
          </ICMSSN102>`;

    return `
    <det nItem="${idx + 1}">
      <prod>
        <cProd>${escaparXml(limparTexto(item.codigo, 60))}</cProd>
        <cEAN>SEM GTIN</cEAN>
        <xProd>${escaparXml(limparTexto(item.descricao, 120))}</xProd>
        <NCM>${padZeros(item.ncm || '21069090', 8)}</NCM>
        ${item.cest ? `<CEST>${padZeros(item.cest, 7)}</CEST>` : ''}
        <CFOP>${item.cfop || config.cfop_padrao || '5102'}</CFOP>
        <uCom>${escaparXml(limparTexto(item.unidade || 'UN', 6))}</uCom>
        <qCom>${formatarValor(item.quantidade, 4)}</qCom>
        <vUnCom>${formatarValor(item.valorUnitario, 10)}</vUnCom>
        <vProd>${formatarValor(item.valorTotal)}</vProd>
        <cEANTrib>SEM GTIN</cEANTrib>
        <uTrib>${escaparXml(limparTexto(item.unidade || 'UN', 6))}</uTrib>
        <qTrib>${formatarValor(item.quantidade, 4)}</qTrib>
        <vUnTrib>${formatarValor(item.valorUnitario, 10)}</vUnTrib>
        <indTot>1</indTot>
      </prod>
      <imposto>
        <ICMS>${tributacaoIcms}
        </ICMS>
        <PIS>
          <PISNT>
            <CST>${config.cst_pis_cofins || '07'}</CST>
          </PISNT>
        </PIS>
        <COFINS>
          <COFINSNT>
            <CST>${config.cst_pis_cofins || '07'}</CST>
          </COFINSNT>
        </COFINS>
      </imposto>
    </det>`;
  }).join('');

  // --------------------------------------------------------------------- Totais
  const total = `
    <total>
      <ICMSTot>
        <vBC>0.00</vBC>
        <vICMS>0.00</vICMS>
        <vICMSDeson>0.00</vICMSDeson>
        <vFCP>0.00</vFCP>
        <vBCST>0.00</vBCST>
        <vST>0.00</vST>
        <vFCPST>0.00</vFCPST>
        <vFCPSTRet>0.00</vFCPSTRet>
        <vProd>${formatarValor(totalProdutos)}</vProd>
        <vFrete>0.00</vFrete>
        <vSeg>0.00</vSeg>
        <vDesc>0.00</vDesc>
        <vII>0.00</vII>
        <vIPI>0.00</vIPI>
        <vIPIDevol>0.00</vIPIDevol>
        <vPIS>0.00</vPIS>
        <vCOFINS>0.00</vCOFINS>
        <vOutro>0.00</vOutro>
        <vNF>${formatarValor(dados.valorTotal)}</vNF>
      </ICMSTot>
    </total>`;

  // ------------------------------------------------------------------ Pagamento
  const detPag = dados.pagamentos.map(p => `
      <detPag>
        <indPag>0</indPag>
        <tPag>${CODIGO_PAGAMENTO_SEFAZ[p.metodo] || '99'}</tPag>
        <vPag>${formatarValor(p.valor)}</vPag>
      </detPag>`).join('');

  const pag = `
    <pag>${detPag}
      <vTroco>${formatarValor(dados.troco || 0)}</vTroco>
    </pag>`;

  // ------------------------------------------------- Informações complementares
  const avisoAmbiente = ambiente === 2
    ? 'EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL'
    : '';

  const infoAdicional = [avisoAmbiente, dados.infoComplementar]
    .filter(Boolean)
    .join(' | ');

  const infAdic = infoAdicional
    ? `
    <infAdic>
      <infCpl>${escaparXml(limparTexto(infoAdicional, 5000))}</infCpl>
    </infAdic>`
    : '';

  // ------------------------------------------------------------------- QR Code
  const qrCode = gerarQrCodeNfce({
    chaveAcesso,
    tipoAmbiente: ambiente,
    idTokenCsc: config.csc_id,
    csc: config.csc,
    urlConsulta: config.url_consulta
  });

  const infNFeSupl = `
    <infNFeSupl>
      <qrCode><![CDATA[${qrCode}]]></qrCode>
      <urlChave>${escaparXml(config.url_consulta)}</urlChave>
    </infNFeSupl>`;

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<NFe xmlns="http://www.portalfiscal.inf.br/nfe">
  <infNFe versao="4.00" Id="NFe${chaveAcesso}">${ide}${emit}${dest}${detXml}${total}${pag}${infAdic}
  </infNFe>${infNFeSupl}
</NFe>
<!--
  DOCUMENTO NAO ASSINADO E NAO TRANSMITIDO A SEFAZ.
  Sem assinatura digital ICP-Brasil e sem protocolo de autorizacao,
  este arquivo NAO possui valor fiscal.
-->`;

  return {
    chaveAcesso,
    xml,
    qrCode,
    urlConsulta: config.url_consulta,
    numero: dados.numero,
    serie: config.serie_nfce
  };
}
