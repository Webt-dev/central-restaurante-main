import React, { useState, useEffect } from 'react';
import { api } from '../services/api';
import { formatDateTimeBR } from '../utils/dateUtils';
import {
  FileText, Settings, RefreshCw, Save, AlertTriangle, CheckCircle2, X,
  Download, Search, ShieldAlert, Info
} from 'lucide-react';

type Aba = 'documentos' | 'config';

const STATUS_LABEL: Record<string, string> = {
  PENDENTE: 'Pendente',
  GERADO: 'Gerado (não enviado)',
  AUTORIZADO: 'Autorizado',
  REJEITADO: 'Rejeitado',
  CANCELADO: 'Cancelado'
};

export const FiscalScreen: React.FC = () => {
  const [aba, setAba] = useState<Aba>('documentos');
  const [documentos, setDocumentos] = useState<any[]>([]);
  const [resumo, setResumo] = useState<any | null>(null);
  const [config, setConfig] = useState<any | null>(null);
  const [validacao, setValidacao] = useState<{ pronto: boolean; pendencias: string[] } | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [salvando, setSalvando] = useState(false);
  const [mensagem, setMensagem] = useState<{ tipo: 'success' | 'error'; texto: string } | null>(null);
  const [xmlAberto, setXmlAberto] = useState<string | null>(null);
  const [busca, setBusca] = useState('');

  useEffect(() => {
    carregarTudo();
  }, []);

  async function carregarTudo() {
    setCarregando(true);
    try {
      const [docs, res, cfg, val] = await Promise.all([
        api.getFiscalDocumentos(),
        api.getFiscalResumo(),
        api.getFiscalConfig(),
        api.validarFiscalConfig()
      ]);
      setDocumentos(docs);
      setResumo(res);
      setConfig(cfg);
      setValidacao(val);
    } catch (err: any) {
      mostrar('error', err.message || 'Não foi possível carregar o módulo fiscal.');
    } finally {
      setCarregando(false);
    }
  }

  function mostrar(tipo: 'success' | 'error', texto: string) {
    setMensagem({ tipo, texto });
    setTimeout(() => setMensagem(null), 5000);
  }

  async function salvarConfig(e: React.FormEvent) {
    e.preventDefault();
    setSalvando(true);
    try {
      const salvo = await api.updateFiscalConfig(config);
      setConfig(salvo);
      if (salvo.validacao) setValidacao(salvo.validacao);
      mostrar('success', 'Configuração fiscal salva.');
    } catch (err: any) {
      mostrar('error', err.message || 'Não foi possível salvar.');
    } finally {
      setSalvando(false);
    }
  }

  async function verXml(id: string) {
    try {
      const res = await api.getFiscalXml(id);
      setXmlAberto(res.xml);
    } catch (err: any) {
      mostrar('error', err.message || 'XML não encontrado.');
    }
  }

  async function exportar() {
    const hoje = new Date().toISOString().split('T')[0]!;
    const primeiroDia = hoje.substring(0, 8) + '01';
    try {
      const res = await api.exportarFiscal(primeiroDia, hoje);
      mostrar('success', `${res.total} arquivo(s) exportados para: ${res.pasta}`);
    } catch (err: any) {
      mostrar('error', err.message || 'Não foi possível exportar.');
    }
  }

  const docsFiltrados = documentos.filter(d =>
    !busca ||
    String(d.numero).includes(busca) ||
    (d.chave_acesso || '').includes(busca) ||
    String(d.table_number).includes(busca)
  );

  const emHomologacao = resumo && Number(resumo.ambiente) === 2;

  if (carregando) {
    return <div className="empty-state">Carregando módulo fiscal...</div>;
  }

  return (
    <div className="page">
      {/* XML */}
      {xmlAberto && (
        <div className="modal-overlay">
          <div className="modal modal-xl animate-fade-in">
            <div className="modal-head">
              <h2 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <FileText size={18} color="var(--text-secondary)" /> Arquivo XML da nota
              </h2>
              <button onClick={() => setXmlAberto(null)} className="btn-close"><X size={19} /></button>
            </div>
            <pre className="receipt-preview" style={{ maxHeight: '440px', fontSize: '0.7rem' }}>{xmlAberto}</pre>
            <button onClick={() => setXmlAberto(null)} className="btn btn-outline btn-block">Fechar</button>
          </div>
        </div>
      )}

      <div className="page-head">
        <div>
          <h1 className="page-title">Notas fiscais (NFC-e)</h1>
          <div className="page-subtitle">Registro fiscal das vendas fechadas no caixa.</div>
        </div>
        <div className="toolbar">
          <button onClick={carregarTudo} className="btn btn-outline btn-sm"><RefreshCw size={15} /> Atualizar</button>
          <button onClick={exportar} className="btn btn-outline btn-sm"><Download size={15} /> Exportar para o contador</button>
        </div>
      </div>

      {/* Aviso permanente e honesto sobre o estágio da emissão */}
      <div className="aviso-homologacao">
        <ShieldAlert size={20} style={{ flexShrink: 0, marginTop: '2px' }} />
        <div>
          <strong>Este módulo ainda não transmite notas para a SEFAZ.</strong>
          <div style={{ marginTop: '4px' }}>
            O sistema monta o arquivo XML e guarda o registro de cada venda, mas os documentos
            <strong> não têm valor fiscal</strong> enquanto não forem assinados com certificado digital
            e autorizados pela SEFAZ do seu estado. Use como controle interno e converse com seu
            contador antes de usar isso como nota oficial.
          </div>
        </div>
      </div>

      {mensagem && (
        <div className={`alert ${mensagem.tipo === 'success' ? 'alert-success' : 'alert-error'}`}>
          {mensagem.tipo === 'success' ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />}
          {mensagem.texto}
        </div>
      )}

      {validacao && !validacao.pronto && (
        <div className="alert alert-warning" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: '6px' }}>
          <strong>Faltam dados para gerar as notas:</strong>
          <ul style={{ paddingLeft: '18px', fontWeight: 400, fontSize: '0.84rem' }}>
            {validacao.pendencias.map((p, i) => <li key={i}>{p}</li>)}
          </ul>
        </div>
      )}

      <div className="grid-auto">
        <div className="card stat">
          <span className="stat-icon"><FileText size={19} /></span>
          <div>
            <div className="stat-label">Documentos hoje</div>
            <div className="stat-value">{resumo?.total_documentos || 0}</div>
          </div>
        </div>
        <div className="card stat">
          <span className="stat-icon"><CheckCircle2 size={19} /></span>
          <div>
            <div className="stat-label">Valor registrado</div>
            <div className="stat-value">R$ {(resumo?.valor_total || 0).toFixed(2)}</div>
          </div>
        </div>
        <div className="card stat">
          <span className="stat-icon"><AlertTriangle size={19} /></span>
          <div>
            <div className="stat-label">Pendentes</div>
            <div className="stat-value" style={{ color: (resumo?.por_status?.PENDENTE || 0) > 0 ? 'var(--red)' : 'var(--text-primary)' }}>
              {resumo?.por_status?.PENDENTE || 0}
            </div>
          </div>
        </div>
        <div className="card stat">
          <span className="stat-icon"><Info size={19} /></span>
          <div>
            <div className="stat-label">Ambiente</div>
            <div className="stat-value" style={{ fontSize: '1rem' }}>
              {emHomologacao ? 'Homologação (teste)' : 'Produção'}
            </div>
          </div>
        </div>
      </div>

      <div className="tabs">
        <button onClick={() => setAba('documentos')} className={`tab ${aba === 'documentos' ? 'is-active' : ''}`}>
          <FileText size={16} /> Documentos <span className="tab-count">{documentos.length}</span>
        </button>
        <button onClick={() => setAba('config')} className={`tab ${aba === 'config' ? 'is-active' : ''}`}>
          <Settings size={16} /> Dados fiscais
        </button>
      </div>

      {aba === 'documentos' && (
        <div className="card card-pad">
          <div className="card-head">
            <h2>Notas geradas</h2>
            <div className="input-group" style={{ maxWidth: '300px' }}>
              <span className="input-icon"><Search size={16} /></span>
              <input
                type="text"
                placeholder="Buscar por número, mesa ou chave"
                value={busca}
                onChange={e => setBusca(e.target.value)}
                className="input"
              />
              {busca && <button onClick={() => setBusca('')} className="input-clear"><X size={15} /></button>}
            </div>
          </div>

          <div className="list-meta">
            <span>{docsFiltrados.length} documento(s)</span>
          </div>

          <div className="table-wrap scroll-area scroll-table">
            <table className="data-table table-sticky">
              <thead>
                <tr>
                  <th>Número</th>
                  <th>Mesa</th>
                  <th>Valor</th>
                  <th>Situação</th>
                  <th>Chave de acesso</th>
                  <th>Emitido em</th>
                  <th style={{ textAlign: 'right' }}>Ações</th>
                </tr>
              </thead>
              <tbody>
                {docsFiltrados.map(doc => (
                  <tr key={doc.id}>
                    <td style={{ fontWeight: 600 }}>
                      {doc.numero > 0 ? `${doc.numero}/${doc.serie}` : '—'}
                    </td>
                    <td>{doc.table_number || '—'}</td>
                    <td className="money">R$ {Number(doc.valor_total).toFixed(2)}</td>
                    <td>
                      <span className={`fiscal-status fiscal-${String(doc.status).toLowerCase()}`}>
                        {STATUS_LABEL[doc.status] || doc.status}
                      </span>
                      {doc.motivo_rejeicao && (
                        <div className="hint" style={{ marginTop: '3px', maxWidth: '260px' }}>{doc.motivo_rejeicao}</div>
                      )}
                    </td>
                    <td><span className="chave-acesso">{doc.chave_acesso || '—'}</span></td>
                    <td className="hint">{formatDateTimeBR(doc.created_at)}</td>
                    <td>
                      <div className="cell-actions">
                        {doc.xml_path && (
                          <button onClick={() => verXml(doc.id)} className="btn btn-outline btn-sm">
                            <FileText size={14} /> XML
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
                {docsFiltrados.length === 0 && (
                  <tr><td colSpan={7}><div className="empty-state">Nenhum documento fiscal registrado.</div></td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {aba === 'config' && config && (
        <form onSubmit={salvarConfig} className="card card-pad" style={{ maxWidth: '820px', display: 'flex', flexDirection: 'column', gap: '18px' }}>
          <div className="card-head"><h2>Dados fiscais do restaurante</h2></div>

          <p className="hint">
            Peça estes dados ao seu contador. Eles vão impressos em cada nota e precisam bater
            exatamente com o cadastro da SEFAZ.
          </p>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '14px' }}>
            <div className="field">
              <label className="label">CNPJ</label>
              <input type="text" value={config.cnpj || ''} onChange={e => setConfig({ ...config, cnpj: e.target.value })} className="input" placeholder="00.000.000/0001-00" />
            </div>
            <div className="field">
              <label className="label">Inscrição Estadual</label>
              <input type="text" value={config.inscricao_estadual || ''} onChange={e => setConfig({ ...config, inscricao_estadual: e.target.value })} className="input" />
            </div>
            <div className="field">
              <label className="label">Razão social</label>
              <input type="text" value={config.razao_social || ''} onChange={e => setConfig({ ...config, razao_social: e.target.value })} className="input" />
            </div>
            <div className="field">
              <label className="label">Nome fantasia</label>
              <input type="text" value={config.nome_fantasia || ''} onChange={e => setConfig({ ...config, nome_fantasia: e.target.value })} className="input" />
            </div>
            <div className="field">
              <label className="label">Logradouro</label>
              <input type="text" value={config.logradouro || ''} onChange={e => setConfig({ ...config, logradouro: e.target.value })} className="input" />
            </div>
            <div className="field">
              <label className="label">Número</label>
              <input type="text" value={config.numero_endereco || ''} onChange={e => setConfig({ ...config, numero_endereco: e.target.value })} className="input" />
            </div>
            <div className="field">
              <label className="label">Bairro</label>
              <input type="text" value={config.bairro || ''} onChange={e => setConfig({ ...config, bairro: e.target.value })} className="input" />
            </div>
            <div className="field">
              <label className="label">Município</label>
              <input type="text" value={config.nome_municipio || ''} onChange={e => setConfig({ ...config, nome_municipio: e.target.value })} className="input" />
            </div>
            <div className="field">
              <label className="label">Código IBGE do município</label>
              <input type="text" value={config.codigo_municipio || ''} onChange={e => setConfig({ ...config, codigo_municipio: e.target.value })} className="input" placeholder="3550308" />
              <span className="hint">7 dígitos. Seu contador informa.</span>
            </div>
            <div className="field">
              <label className="label">UF</label>
              <input type="text" maxLength={2} value={config.uf || ''} onChange={e => setConfig({ ...config, uf: e.target.value.toUpperCase() })} className="input" />
            </div>
            <div className="field">
              <label className="label">CEP</label>
              <input type="text" value={config.cep || ''} onChange={e => setConfig({ ...config, cep: e.target.value })} className="input" />
            </div>
            <div className="field">
              <label className="label">Telefone</label>
              <input type="text" value={config.telefone || ''} onChange={e => setConfig({ ...config, telefone: e.target.value })} className="input" />
            </div>
          </div>

          <div style={{ borderTop: '1px solid var(--border)', paddingTop: '16px' }}>
            <h3 style={{ marginBottom: '12px' }}>Configuração de emissão</h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '14px' }}>
              <div className="field">
                <label className="label">Regime tributário</label>
                <select value={config.regime_tributario || '1'} onChange={e => setConfig({ ...config, regime_tributario: e.target.value })} className="input">
                  <option value="1">Simples Nacional</option>
                  <option value="2">Simples Nacional - excesso de sublimite</option>
                  <option value="3">Regime Normal</option>
                </select>
              </div>
              <div className="field">
                <label className="label">Ambiente</label>
                <select value={String(config.ambiente ?? 2)} onChange={e => setConfig({ ...config, ambiente: Number(e.target.value) })} className="input">
                  <option value="2">Homologação (teste, sem valor fiscal)</option>
                  <option value="1">Produção (valor fiscal real)</option>
                </select>
                <span className="hint">Mantenha em homologação até o contador validar tudo.</span>
              </div>
              <div className="field">
                <label className="label">Série da NFC-e</label>
                <input type="number" min="1" max="999" value={config.serie_nfce ?? 1} onChange={e => setConfig({ ...config, serie_nfce: Number(e.target.value) })} className="input" />
              </div>
              <div className="field">
                <label className="label">ID do CSC</label>
                <input type="text" value={config.csc_id || ''} onChange={e => setConfig({ ...config, csc_id: e.target.value })} className="input" placeholder="000001" />
              </div>
              <div className="field">
                <label className="label">CSC (Código de Segurança do Contribuinte)</label>
                <input type="password" placeholder={config.csc_configurado ? '•••••••• (já configurado)' : 'Obtido no site da SEFAZ'} onChange={e => setConfig({ ...config, csc: e.target.value })} className="input" />
                <span className="hint">Deixe em branco para manter o atual.</span>
              </div>
              <div className="field">
                <label className="label">URL de consulta da NFC-e</label>
                <input type="text" value={config.url_consulta || ''} onChange={e => setConfig({ ...config, url_consulta: e.target.value })} className="input" placeholder="https://www.nfce.fazenda.___.gov.br/consulta" />
                <span className="hint">Endereço do portal do seu estado, usado no QR Code.</span>
              </div>
              <div className="field">
                <label className="label">CFOP padrão</label>
                <input type="text" value={config.cfop_padrao || '5102'} onChange={e => setConfig({ ...config, cfop_padrao: e.target.value })} className="input" />
              </div>
              <div className="field">
                <label className="label">CSOSN padrão (Simples)</label>
                <input type="text" value={config.csosn_padrao || '102'} onChange={e => setConfig({ ...config, csosn_padrao: e.target.value })} className="input" />
              </div>
            </div>
          </div>

          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={config.emissao_ativa === true || config.emissao_ativa === 'true'}
              onChange={e => setConfig({ ...config, emissao_ativa: e.target.checked })}
            />
            Gerar documento fiscal automaticamente ao fechar cada mesa
          </label>

          <button type="submit" className="btn btn-primary btn-block btn-lg" disabled={salvando}>
            <Save size={17} /> {salvando ? 'Salvando...' : 'Salvar dados fiscais'}
          </button>
        </form>
      )}
    </div>
  );
};
