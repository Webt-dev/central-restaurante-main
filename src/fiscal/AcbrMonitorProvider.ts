import net from 'node:net';
import {
  Ambiente, FiscalProvider, FiscalIndisponivelError, NfceInput, ResultadoEmissao, StatusServico
} from './types.js';

/**
 * Provedor fiscal via ACBrMonitorPLUS (Projeto ACBr), rodando no computador
 * do restaurante.
 *
 * O ACBrMonitor guarda o certificado A1, o CSC/ID Token e as URLs da SEFAZ
 * do estado; este sistema só manda os dados da venda. Protocolo TCP (porta
 * padrão 3434): cada comando termina com "\r\n.\r\n" e cada resposta termina
 * com o caractere ETX (0x03). Respostas começam com "OK:" ou "ERRO:".
 *
 * IMPORTANTE (prova de conceito): os nomes de comandos e campos do arquivo
 * INI seguem a documentação do ACBrMonitorPLUS para NF-e/NFC-e 4.00 e
 * precisam ser conferidos contra a versão instalada, em homologação, antes
 * do primeiro cliente. Ajustes ficam todos neste arquivo.
 */

const ETX = '\x03';
const COMMAND_TIMEOUT_MS = 45_000;

export interface AcbrConfig {
  host: string;
  port: number;
}

function sendCommand(cfg: AcbrConfig, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: cfg.host, port: cfg.port });
    let buffer = '';
    let greeted = false;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new FiscalIndisponivelError('O ACBrMonitor não respondeu a tempo.'));
    }, COMMAND_TIMEOUT_MS);

    socket.setEncoding('latin1');
    socket.on('data', chunk => {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf(ETX)) >= 0) {
        const message = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!greeted) {
          // Primeira mensagem é a saudação do ACBrMonitor; só então enviamos o comando.
          greeted = true;
          socket.write(`${command}\r\n.\r\n`, 'latin1');
          continue;
        }
        clearTimeout(timer);
        socket.end();
        resolve(message.trim());
        return;
      }
    });
    socket.on('error', err => {
      clearTimeout(timer);
      reject(new FiscalIndisponivelError(`Sem conexão com o ACBrMonitor em ${cfg.host}:${cfg.port} (${err.message}).`));
    });
  });
}

/** Lê uma resposta no formato INI do ACBr em { "SECAO.chave": valor } (chaves em minúsculas). */
export function parseIni(text: string): Map<string, string> {
  const map = new Map<string, string>();
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const sec = /^\[(.+)]$/.exec(line);
    if (sec) {
      section = sec[1]!.toLowerCase();
      continue;
    }
    const eq = line.indexOf('=');
    if (eq > 0) map.set(`${section}.${line.slice(0, eq).trim().toLowerCase()}`, line.slice(eq + 1).trim());
  }
  return map;
}

/** Primeiro valor encontrado para qualquer uma das chaves, em qualquer seção. */
function pick(map: Map<string, string>, ...keys: string[]): string | undefined {
  for (const key of keys.map(k => k.toLowerCase())) {
    for (const [k, v] of map) {
      if (k.endsWith(`.${key}`) && v) return v;
    }
  }
  return undefined;
}

function clean(text: string, max: number): string {
  // Aspas e quebras de linha quebrariam o parâmetro do comando.
  return text.replace(/["\r\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function money(v: number): string {
  return v.toFixed(2);
}

/** Monta o INI da NFC-e no formato aceito pelo ACBrMonitor (NFe.CriarNFe / CriarEnviarNFe). */
export function buildIni(input: NfceInput): string {
  const e = input.emitente;
  const lines: string[] = [];
  const section = (name: string, fields: Record<string, string | number | undefined>) => {
    lines.push(`[${name}]`);
    for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== '') lines.push(`${k}=${v}`);
  };

  section('infNFe', { versao: '4.00' });
  section('Identificacao', {
    natOp: 'VENDA',
    mod: 65,
    serie: input.serie,
    nNF: input.numero,
    dhEmi: input.emissao,
    tpNF: 1,
    idDest: 1,
    tpImp: 4,
    tpEmis: input.tp_emis,
    tpAmb: input.ambiente,
    finNFe: 1,
    indFinal: 1,
    indPres: 1,
    dhCont: input.contingencia?.desde,
    xJust: input.contingencia ? clean(input.contingencia.justificativa, 256) : undefined
  });
  section('Emitente', {
    CNPJCPF: e.cnpj,
    xNome: clean(e.razao_social, 60),
    xFant: clean(e.nome_fantasia, 60),
    IE: e.ie,
    CRT: e.crt,
    xLgr: clean(e.logradouro, 60),
    nro: clean(e.numero, 60),
    xBairro: clean(e.bairro, 60),
    cMun: e.codigo_municipio,
    xMun: clean(e.municipio, 60),
    UF: e.uf,
    CEP: e.cep,
    Fone: e.telefone
  });
  if (input.cpf_consumidor) section('Destinatario', { CNPJCPF: input.cpf_consumidor });

  input.itens.forEach((item, i) => {
    const n = String(i + 1).padStart(3, '0');
    section(`Produto${n}`, {
      cProd: clean(item.codigo, 60),
      cEAN: item.gtin || 'SEM GTIN',
      xProd: clean(item.descricao, 120),
      NCM: item.ncm,
      CEST: item.cest,
      CFOP: item.cfop,
      uCom: item.unidade,
      qCom: item.quantidade.toFixed(4),
      vUnCom: item.valor_unitario.toFixed(10),
      vProd: money(item.valor_total),
      cEANTrib: item.gtin || 'SEM GTIN',
      uTrib: item.unidade,
      qTrib: item.quantidade.toFixed(4),
      vUnTrib: item.valor_unitario.toFixed(10),
      indTot: 1
    });
    section(`ICMS${n}`, item.csosn ? { orig: item.origem, CSOSN: item.csosn } : { orig: item.origem, CST: item.cst_icms });
    section(`PIS${n}`, { CST: item.cst_pis_cofins });
    section(`COFINS${n}`, { CST: item.cst_pis_cofins });
  });

  section('Total', {
    vBC: '0.00', vICMS: '0.00', vICMSDeson: '0.00', vFCP: '0.00', vBCST: '0.00', vST: '0.00',
    vFCPST: '0.00', vFCPSTRet: '0.00', vProd: money(input.valor_total), vFrete: '0.00', vSeg: '0.00',
    vDesc: '0.00', vII: '0.00', vIPI: '0.00', vIPIDevol: '0.00', vPIS: '0.00', vCOFINS: '0.00',
    vOutro: '0.00', vNF: money(input.valor_total)
  });
  section('Transportador', { modFrete: 9 });
  input.pagamentos.forEach((p, i) => {
    section(`pag${String(i + 1).padStart(3, '0')}`, { tPag: p.tpag, vPag: money(p.valor) });
  });
  if (input.info_complementar) section('DadosAdicionais', { infCpl: clean(input.info_complementar, 2000) });

  return lines.join('\n');
}

function parseEmissao(response: string, contingencia: boolean): ResultadoEmissao {
  if (response.startsWith('ERRO')) {
    const motivo = response.replace(/^ERRO:\s*/, '');
    // Falha de comunicação com a SEFAZ costuma vir como ERRO sem cStat: tratamos como indisponível.
    if (/timeout|tempo|conex|connect|socket|host|webservice|servi[cç]o/i.test(motivo) && !/rejei/i.test(motivo)) {
      throw new FiscalIndisponivelError(motivo);
    }
    return { status: 'REJEITADO', motivo };
  }

  const map = parseIni(response.replace(/^OK:\s*/, ''));
  const chave = pick(map, 'chDFe', 'ChNFe', 'chave', 'Id')?.replace(/^NFe/i, '');
  const xml_path = pick(map, 'Arquivo', 'NomeArq', 'Path');
  const qr_code_url = pick(map, 'QRCode', 'qrCode');

  if (contingencia) {
    if (!chave) return { status: 'REJEITADO', motivo: 'O ACBr não retornou a chave da nota em contingência.' };
    return { status: 'CONTINGENCIA', chave, xml_path, qr_code_url };
  }

  const cStat = pick(map, 'cStat', 'CStat');
  const motivo = pick(map, 'xMotivo', 'XMotivo') ?? '';
  const protocolo = pick(map, 'nProt', 'NProt');
  // 100 = autorizado; 150 = autorizado fora de prazo.
  if ((cStat === '100' || cStat === '150') && chave && protocolo) {
    return { status: 'AUTORIZADO', chave, protocolo, xml_path, qr_code_url, motivo };
  }
  // 108/109 = serviço paralisado: vale contingência.
  if (cStat === '108' || cStat === '109') throw new FiscalIndisponivelError(`SEFAZ indisponível (${cStat} ${motivo}).`);
  return { status: 'REJEITADO', chave, motivo: `${cStat ?? '?'} - ${motivo || 'Rejeitada pela SEFAZ.'}` };
}

export class AcbrMonitorProvider implements FiscalProvider {
  readonly nome = 'acbr';

  constructor(private readonly cfg: AcbrConfig) {}

  async statusServico(_ambiente: Ambiente, _uf: string): Promise<StatusServico> {
    try {
      const resp = await sendCommand(this.cfg, 'NFE.StatusServico');
      if (resp.startsWith('ERRO')) return { online: false, motivo: resp };
      const map = parseIni(resp.replace(/^OK:\s*/, ''));
      const cStat = pick(map, 'cStat', 'CStat');
      const motivo = pick(map, 'xMotivo', 'XMotivo') ?? resp;
      return { online: cStat === '107', motivo: `${cStat ?? ''} ${motivo}`.trim() };
    } catch (err) {
      return { online: false, motivo: (err as Error).message };
    }
  }

  async emitir(input: NfceInput): Promise<ResultadoEmissao> {
    const ini = buildIni(input);
    if (input.tp_emis === 9) {
      // Contingência offline: o ACBr gera e assina a nota localmente; a transmissão vem depois.
      const resp = await sendCommand(this.cfg, `NFE.CriarNFe("${ini}")`);
      return parseEmissao(resp, true);
    }
    const resp = await sendCommand(this.cfg, `NFE.CriarEnviarNFe("${ini}", 1, 0, "", 1)`);
    return parseEmissao(resp, false);
  }

  async transmitirContingencia(_chave: string, input: NfceInput): Promise<ResultadoEmissao> {
    // A nota já existe assinada no ACBr: reenviamos o mesmo INI (mesma chave/cNF) em modo de envio.
    const resp = await sendCommand(this.cfg, `NFE.CriarEnviarNFe("${buildIni(input)}", 1, 0, "", 1)`);
    return parseEmissao(resp, false);
  }

  async cancelar(params: { chave: string; protocolo: string; justificativa: string; cnpj: string }) {
    const resp = await sendCommand(this.cfg, `NFE.CancelarNFe("${params.chave}", "${clean(params.justificativa, 255)}", "${params.cnpj}")`);
    if (resp.startsWith('ERRO')) return { ok: false, motivo: resp };
    const map = parseIni(resp.replace(/^OK:\s*/, ''));
    const cStat = pick(map, 'cStat', 'CStat');
    // 135 = evento registrado e vinculado; 155 = cancelamento fora de prazo homologado.
    const ok = cStat === '135' || cStat === '155';
    return { ok, protocolo: pick(map, 'nProt', 'NProt'), motivo: `${cStat ?? ''} ${pick(map, 'xMotivo', 'XMotivo') ?? ''}`.trim() };
  }

  async imprimir(chave: string): Promise<void> {
    await sendCommand(this.cfg, `NFE.ImprimirDANFE("${chave}")`);
  }
}
