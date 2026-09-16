import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { db } from '../config/database.js';
import { construirXmlNfce, ConfigFiscal, ItemFiscal, PagamentoFiscal } from '../services/NfceXmlBuilder.js';
import { validarCnpj, validarCpf, somenteDigitos } from '../utils/fiscalUtils.js';

export type StatusFiscal = 'PENDENTE' | 'GERADO' | 'AUTORIZADO' | 'REJEITADO' | 'CANCELADO';

export interface DocumentoFiscal {
  id: string;
  order_id: string;
  table_number: number;
  numero: number;
  serie: number;
  modelo: string;
  chave_acesso: string | null;
  status: StatusFiscal;
  ambiente: number;
  valor_total: number;
  cpf_consumidor: string | null;
  xml_path: string | null;
  qr_code: string | null;
  protocolo: string | null;
  motivo_rejeicao: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Pasta base dos documentos gerados pelo sistema.
 *
 * Independente do documentPaths.ts para não depender de nomes de export que
 * variam entre versões do projeto. Usa a Área de Trabalho quando ela existe,
 * como o restante do sistema já faz com cupons e relatórios.
 */
function getPastaDocumentos(): string {
  const home = os.homedir();
  const candidatos = [
    path.join(home, 'Desktop'),
    path.join(home, 'Área de Trabalho'),
    path.join(home, 'OneDrive', 'Desktop'),
    path.join(home, 'OneDrive', 'Área de Trabalho')
  ];

  const desktop = candidatos.find(p => fs.existsSync(p));
  const base = path.join(desktop || home, 'CentralRestaurante');

  if (!fs.existsSync(base)) fs.mkdirSync(base, { recursive: true });
  return base;
}

const CONFIG_PADRAO: ConfigFiscal = {
  cnpj: '',
  inscricao_estadual: '',
  razao_social: '',
  nome_fantasia: '',
  logradouro: '',
  numero_endereco: '',
  bairro: '',
  codigo_municipio: '',
  nome_municipio: '',
  uf: 'SP',
  cep: '',
  telefone: '',
  regime_tributario: '1',
  serie_nfce: 1,
  ambiente: 2, // começa em homologação, de propósito
  csc: '',
  csc_id: '',
  url_consulta: '',
  cfop_padrao: '5102',
  csosn_padrao: '102',
  cst_pis_cofins: '07'
};

export class FiscalRepository {
  // ==========================================
  // CONFIGURAÇÃO FISCAL
  // ==========================================
  static getConfig(): ConfigFiscal & { emissao_ativa: boolean } {
    const rows = db.prepare('SELECT key, value FROM fiscal_settings').all() as { key: string; value: string }[];
    const map: Record<string, string> = {};
    rows.forEach(r => { map[r.key] = r.value; });

    return {
      cnpj: map['cnpj'] ?? CONFIG_PADRAO.cnpj,
      inscricao_estadual: map['inscricao_estadual'] ?? CONFIG_PADRAO.inscricao_estadual,
      razao_social: map['razao_social'] ?? CONFIG_PADRAO.razao_social,
      nome_fantasia: map['nome_fantasia'] ?? CONFIG_PADRAO.nome_fantasia,
      logradouro: map['logradouro'] ?? CONFIG_PADRAO.logradouro,
      numero_endereco: map['numero_endereco'] ?? CONFIG_PADRAO.numero_endereco,
      bairro: map['bairro'] ?? CONFIG_PADRAO.bairro,
      codigo_municipio: map['codigo_municipio'] ?? CONFIG_PADRAO.codigo_municipio,
      nome_municipio: map['nome_municipio'] ?? CONFIG_PADRAO.nome_municipio,
      uf: map['uf'] ?? CONFIG_PADRAO.uf,
      cep: map['cep'] ?? CONFIG_PADRAO.cep,
      telefone: map['telefone'] ?? CONFIG_PADRAO.telefone,
      regime_tributario: map['regime_tributario'] ?? CONFIG_PADRAO.regime_tributario,
      serie_nfce: Number(map['serie_nfce'] ?? CONFIG_PADRAO.serie_nfce),
      ambiente: Number(map['ambiente'] ?? CONFIG_PADRAO.ambiente),
      csc: map['csc'] ?? CONFIG_PADRAO.csc,
      csc_id: map['csc_id'] ?? CONFIG_PADRAO.csc_id,
      url_consulta: map['url_consulta'] ?? CONFIG_PADRAO.url_consulta,
      cfop_padrao: map['cfop_padrao'] ?? CONFIG_PADRAO.cfop_padrao,
      csosn_padrao: map['csosn_padrao'] ?? CONFIG_PADRAO.csosn_padrao,
      cst_pis_cofins: map['cst_pis_cofins'] ?? CONFIG_PADRAO.cst_pis_cofins,
      emissao_ativa: map['emissao_ativa'] === 'true'
    };
  }

  static updateConfig(data: Record<string, any>): ConfigFiscal & { emissao_ativa: boolean } {
    const upsert = db.prepare(`
      INSERT INTO fiscal_settings (key, value, updated_at)
      VALUES (?, ?, datetime('now', 'localtime'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);

    const permitidos = [
      'cnpj', 'inscricao_estadual', 'razao_social', 'nome_fantasia', 'logradouro',
      'numero_endereco', 'bairro', 'codigo_municipio', 'nome_municipio', 'uf', 'cep',
      'telefone', 'regime_tributario', 'serie_nfce', 'ambiente', 'csc', 'csc_id',
      'url_consulta', 'cfop_padrao', 'csosn_padrao', 'cst_pis_cofins', 'emissao_ativa'
    ];

    for (const chave of permitidos) {
      if (data[chave] !== undefined) {
        upsert.run(chave, String(data[chave]));
      }
    }

    return this.getConfig();
  }

  /**
   * Verifica se a configuração está completa o bastante para gerar documento.
   */
  static validarConfig(): { pronto: boolean; pendencias: string[] } {
    const c = this.getConfig();
    const pendencias: string[] = [];

    if (!c.cnpj) pendencias.push('CNPJ do restaurante não informado.');
    else if (!validarCnpj(c.cnpj)) pendencias.push('O CNPJ informado é inválido.');

    if (!c.inscricao_estadual) pendencias.push('Inscrição Estadual não informada.');
    if (!c.razao_social) pendencias.push('Razão social não informada.');
    if (!c.logradouro || !c.bairro) pendencias.push('Endereço incompleto (logradouro e bairro).');
    if (!c.codigo_municipio) pendencias.push('Código IBGE do município não informado.');
    if (!c.nome_municipio) pendencias.push('Nome do município não informado.');
    if (!c.cep) pendencias.push('CEP não informado.');
    if (!c.csc || !c.csc_id) pendencias.push('CSC e ID do CSC (obtidos no site da SEFAZ) não informados.');
    if (!c.url_consulta) pendencias.push('URL de consulta da NFC-e do seu estado não informada.');

    return { pronto: pendencias.length === 0, pendencias };
  }

  // ==========================================
  // NUMERAÇÃO SEQUENCIAL
  // ==========================================
  static proximoNumero(serie: number): number {
    const tx = db.transaction(() => {
      const row = db.prepare('SELECT ultimo_numero FROM fiscal_sequence WHERE serie = ?').get(serie) as { ultimo_numero: number } | undefined;

      if (!row) {
        db.prepare('INSERT INTO fiscal_sequence (serie, ultimo_numero) VALUES (?, 1)').run(serie);
        return 1;
      }

      const proximo = row.ultimo_numero + 1;
      db.prepare('UPDATE fiscal_sequence SET ultimo_numero = ? WHERE serie = ?').run(proximo, serie);
      return proximo;
    });

    return tx();
  }

  // ==========================================
  // EMISSÃO (GERAÇÃO DO XML)
  // ==========================================
  static gerarDocumento(params: {
    orderId: string;
    tableNumber: number;
    itens: ItemFiscal[];
    pagamentos: PagamentoFiscal[];
    valorTotal: number;
    troco: number;
    cpfConsumidor?: string;
    infoComplementar?: string;
  }): DocumentoFiscal {
    const config = this.getConfig();
    const validacao = this.validarConfig();

    if (!validacao.pronto) {
      // Registra como PENDENTE para não perder a venda nem furar a numeração.
      return this.registrarPendente(params, validacao.pendencias.join(' '));
    }

    const cpf = somenteDigitos(params.cpfConsumidor || '');
    if (cpf && !validarCpf(cpf)) {
      throw new Error('O CPF informado pelo consumidor é inválido.');
    }

    const numero = this.proximoNumero(config.serie_nfce);
    const dataEmissao = new Date();

    const resultado = construirXmlNfce(config, {
      numero,
      dataEmissao,
      itens: params.itens,
      pagamentos: params.pagamentos,
      valorTotal: params.valorTotal,
      troco: params.troco,
      cpfConsumidor: cpf || undefined,
      infoComplementar: params.infoComplementar
    });

    const xmlPath = this.salvarXml(resultado.chaveAcesso, resultado.xml, dataEmissao);

    const id = randomUUID();
    db.prepare(`
      INSERT INTO fiscal_documents
        (id, order_id, table_number, numero, serie, modelo, chave_acesso, status,
         ambiente, valor_total, cpf_consumidor, xml_path, qr_code)
      VALUES (?, ?, ?, ?, ?, '65', ?, 'GERADO', ?, ?, ?, ?, ?)
    `).run(
      id, params.orderId, params.tableNumber, numero, config.serie_nfce,
      resultado.chaveAcesso, config.ambiente, params.valorTotal,
      cpf || null, xmlPath, resultado.qrCode
    );

    return this.findById(id)!;
  }

  private static registrarPendente(params: any, motivo: string): DocumentoFiscal {
    const id = randomUUID();
    const config = this.getConfig();

    db.prepare(`
      INSERT INTO fiscal_documents
        (id, order_id, table_number, numero, serie, modelo, chave_acesso, status,
         ambiente, valor_total, cpf_consumidor, motivo_rejeicao)
      VALUES (?, ?, ?, 0, ?, '65', NULL, 'PENDENTE', ?, ?, ?, ?)
    `).run(
      id, params.orderId, params.tableNumber, config.serie_nfce,
      config.ambiente, params.valorTotal,
      somenteDigitos(params.cpfConsumidor || '') || null,
      `Configuração fiscal incompleta: ${motivo}`
    );

    return this.findById(id)!;
  }

  private static salvarXml(chave: string, xml: string, data: Date): string {
    const base = getPastaDocumentos();
    const ano = data.getFullYear();
    const mes = String(data.getMonth() + 1).padStart(2, '0');
    const dir = path.join(base, 'notas_fiscais', `${ano}-${mes}`);

    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const filePath = path.join(dir, `NFCe_${chave}.xml`);
    fs.writeFileSync(filePath, xml, 'utf-8');
    return filePath;
  }

  // ==========================================
  // CONSULTAS
  // ==========================================
  static findById(id: string): DocumentoFiscal | null {
    const doc = db.prepare('SELECT * FROM fiscal_documents WHERE id = ?').get(id) as DocumentoFiscal | undefined;
    return doc || null;
  }

  static findByOrderId(orderId: string): DocumentoFiscal | null {
    const doc = db.prepare('SELECT * FROM fiscal_documents WHERE order_id = ? ORDER BY created_at DESC LIMIT 1').get(orderId) as DocumentoFiscal | undefined;
    return doc || null;
  }

  static listar(filtros: { data?: string; status?: StatusFiscal; limite?: number } = {}): DocumentoFiscal[] {
    const condicoes: string[] = [];
    const valores: any[] = [];

    if (filtros.data) {
      condicoes.push("date(created_at) = date(?)");
      valores.push(filtros.data);
    }
    if (filtros.status) {
      condicoes.push('status = ?');
      valores.push(filtros.status);
    }

    const where = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '';
    const limite = Math.min(500, filtros.limite || 200);

    return db.prepare(`
      SELECT * FROM fiscal_documents
      ${where}
      ORDER BY created_at DESC
      LIMIT ${limite}
    `).all(...valores) as DocumentoFiscal[];
  }

  static getXml(id: string): string | null {
    const doc = this.findById(id);
    if (!doc || !doc.xml_path || !fs.existsSync(doc.xml_path)) return null;
    return fs.readFileSync(doc.xml_path, 'utf-8');
  }

  static resumoDia(data?: string): {
    data: string;
    total_documentos: number;
    valor_total: number;
    por_status: Record<string, number>;
    ambiente: number;
    emissao_ativa: boolean;
  } {
    const alvo = data || new Date().toISOString().split('T')[0]!;
    const config = this.getConfig();

    const docs = this.listar({ data: alvo, limite: 500 });
    const por_status: Record<string, number> = { PENDENTE: 0, GERADO: 0, AUTORIZADO: 0, REJEITADO: 0, CANCELADO: 0 };

    let valor_total = 0;
    for (const d of docs) {
      por_status[d.status] = (por_status[d.status] || 0) + 1;
      if (d.status !== 'CANCELADO' && d.status !== 'REJEITADO') valor_total += d.valor_total;
    }

    return {
      data: alvo,
      total_documentos: docs.length,
      valor_total: Number(valor_total.toFixed(2)),
      por_status,
      ambiente: config.ambiente,
      emissao_ativa: config.emissao_ativa
    };
  }

  static registrarAutorizacao(id: string, protocolo: string): DocumentoFiscal | null {
    db.prepare(`
      UPDATE fiscal_documents
      SET status = 'AUTORIZADO', protocolo = ?, motivo_rejeicao = NULL,
          updated_at = datetime('now', 'localtime')
      WHERE id = ?
    `).run(protocolo, id);
    return this.findById(id);
  }

  static registrarRejeicao(id: string, motivo: string): DocumentoFiscal | null {
    db.prepare(`
      UPDATE fiscal_documents
      SET status = 'REJEITADO', motivo_rejeicao = ?,
          updated_at = datetime('now', 'localtime')
      WHERE id = ?
    `).run(motivo, id);
    return this.findById(id);
  }

  /** Exporta os XMLs do período em uma pasta única, para enviar ao contador. */
  static exportarPeriodo(dataInicio: string, dataFim: string): { pasta: string; total: number; ausentes: number } {
    const docs = db.prepare(`
      SELECT * FROM fiscal_documents
      WHERE date(created_at) BETWEEN date(?) AND date(?)
        AND xml_path IS NOT NULL
      ORDER BY numero ASC
    `).all(dataInicio, dataFim) as DocumentoFiscal[];

    const base = getPastaDocumentos();
    const pasta = path.join(base, 'notas_fiscais', `export_${dataInicio}_a_${dataFim}`);
    if (!fs.existsSync(pasta)) fs.mkdirSync(pasta, { recursive: true });

    let copiados = 0;
    let ausentes = 0;

    for (const doc of docs) {
      if (doc.xml_path && fs.existsSync(doc.xml_path)) {
        fs.copyFileSync(doc.xml_path, path.join(pasta, path.basename(doc.xml_path)));
        copiados++;
      } else {
        ausentes++;
      }
    }

    // Índice em CSV para o contador conferir a sequência
    const linhas = ['numero;serie;chave_acesso;status;valor_total;data;protocolo'];
    for (const d of docs) {
      linhas.push([
        d.numero, d.serie, d.chave_acesso || '', d.status,
        Number(d.valor_total).toFixed(2), d.created_at, d.protocolo || ''
      ].join(';'));
    }
    fs.writeFileSync(path.join(pasta, 'indice.csv'), linhas.join('\n'), 'utf-8');

    return { pasta, total: copiados, ausentes };
  }
}
