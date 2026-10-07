import React, { useEffect, useState } from 'react';
import { FileText, RefreshCw, XCircle, AlertTriangle, CheckCircle2, Clock, X } from 'lucide-react';
import { api, type DocumentoFiscal, type FiscalStatus, type StatusFiscal } from '../services/api';
import { socket } from '../services/socket';
import { useSession } from '../services/session';
import { formatBRL } from '../services/settings';

const STATUS_LABEL: Record<StatusFiscal, { label: string; badge: string }> = {
  AUTORIZADO: { label: 'Autorizada', badge: 'badge-free' },
  CONTINGENCIA: { label: 'Contingência', badge: 'badge-pending' },
  PENDENTE: { label: 'Enviando', badge: 'badge-info' },
  ERRO: { label: 'Erro', badge: 'badge-occupied' },
  REJEITADO: { label: 'Rejeitada', badge: 'badge-occupied' },
  CANCELADO: { label: 'Cancelada', badge: 'badge-neutral' }
};

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function minutesSince(local: string | null): number {
  if (!local) return Infinity;
  return (Date.now() - new Date(local.replace(' ', 'T')).getTime()) / 60000;
}

/**
 * Notas fiscais (NFC-e) emitidas pelo caixa. Só aparece com o módulo fiscal
 * ligado. Mostra o que foi autorizado, o que está em contingência aguardando
 * transmissão e o que precisa de atenção (erro/rejeição).
 */
export const FiscalScreen: React.FC = () => {
  const session = useSession();
  const isAdmin = session?.user.role === 'ADMIN';
  const [data, setData] = useState(today());
  const [docs, setDocs] = useState<DocumentoFiscal[]>([]);
  const [status, setStatus] = useState<FiscalStatus | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [cancelDoc, setCancelDoc] = useState<DocumentoFiscal | null>(null);
  const [justificativa, setJustificativa] = useState('');

  useEffect(() => {
    load();
    socket.on('fiscal:updated', load);
    return () => {
      socket.off('fiscal:updated', load);
    };
  }, [data]);

  async function load() {
    try {
      const [d, s] = await Promise.all([api.getFiscalDocumentos(data), api.getFiscalStatus()]);
      setDocs(d);
      setStatus(s);
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || 'Não foi possível carregar as notas.' });
    }
  }

  async function handleReprocess(doc: DocumentoFiscal) {
    setBusyId(doc.id);
    try {
      const r = await api.reprocessarFiscal(doc.id);
      setMessage({ type: r.status === 'AUTORIZADO' ? 'success' : 'error', text: `Nota ${r.numero}: ${STATUS_LABEL[r.status].label}${r.motivo ? ` — ${r.motivo}` : ''}` });
      await load();
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setBusyId(null);
    }
  }

  async function handleCancel(e: React.FormEvent) {
    e.preventDefault();
    if (!cancelDoc) return;
    if (justificativa.trim().length < 15) return setMessage({ type: 'error', text: 'A justificativa precisa ter pelo menos 15 caracteres.' });
    setBusyId(cancelDoc.id);
    try {
      await api.cancelarFiscal(cancelDoc.id, justificativa.trim());
      setMessage({ type: 'success', text: `Nota ${cancelDoc.numero} cancelada na SEFAZ.` });
      setCancelDoc(null);
      setJustificativa('');
      await load();
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setBusyId(null);
    }
  }

  const contingencias = status?.por_status.CONTINGENCIA ?? 0;
  const problemas = (status?.por_status.ERRO ?? 0) + (status?.por_status.REJEITADO ?? 0);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Notas fiscais (NFC-e)</h1>
          <div className="page-subtitle">Notas emitidas no fechamento das contas.</div>
        </div>
        <div className="toolbar">
          <input type="date" className="input" value={data} onChange={e => setData(e.target.value)} aria-label="Data" style={{ width: '170px' }} />
          <button className="btn btn-outline btn-sm" onClick={load}><RefreshCw size={15} /> Atualizar</button>
        </div>
      </div>

      {status?.ambiente === 2 && (
        <div className="alert alert-warning">
          <AlertTriangle size={17} /> Ambiente de <strong>homologação</strong>{status.provider === 'simulacao' ? ' (simulação)' : ''}: as notas abaixo NÃO têm valor fiscal.
        </div>
      )}
      {status?.alerta_contingencia && (
        <div className="alert alert-error">
          <AlertTriangle size={17} /> Há nota em contingência há mais de 20 horas. Verifique a internet e o ACBrMonitor: o prazo para transmitir é de cerca de 24 horas.
        </div>
      )}
      {contingencias > 0 && !status?.alerta_contingencia && (
        <div className="alert alert-warning">
          <Clock size={17} /> {contingencias} nota(s) emitida(s) sem internet, aguardando transmissão automática à SEFAZ.
        </div>
      )}
      {problemas > 0 && (
        <div className="alert alert-error">
          <XCircle size={17} /> {problemas} nota(s) com erro ou rejeição precisam de atenção.
        </div>
      )}
      {message && (
        <div className={`alert ${message.type === 'success' ? 'alert-success' : 'alert-error'}`} role="status">
          {message.type === 'success' ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />} {message.text}
        </div>
      )}

      <div className="card">
        {docs.length === 0 ? (
          <div className="empty-state"><FileText size={22} /><p>Nenhuma nota nesta data.</p></div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Nº</th>
                  <th>Mesa</th>
                  <th>Hora</th>
                  <th style={{ textAlign: 'right' }}>Valor</th>
                  <th>Situação</th>
                  <th style={{ textAlign: 'right' }}>Ações</th>
                </tr>
              </thead>
              <tbody>
                {docs.map(d => {
                  const st = STATUS_LABEL[d.status];
                  const podeCancelar = isAdmin && d.status === 'AUTORIZADO' && minutesSince(d.autorizado_em) <= 30;
                  const podeReenviar = ['ERRO', 'CONTINGENCIA', 'PENDENTE'].includes(d.status);
                  return (
                    <tr key={d.id}>
                      <td>{d.numero}<span className="hint"> / série {d.serie}</span></td>
                      <td>{d.table_number ?? '—'}</td>
                      <td>{new Date(d.created_at.replace(' ', 'T')).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</td>
                      <td style={{ textAlign: 'right' }} className="money">{formatBRL(d.valor_total)}</td>
                      <td>
                        <span className={`badge ${st.badge}`}>{st.label}</span>
                        {d.motivo && d.status !== 'AUTORIZADO' && <div className="hint" style={{ maxWidth: '360px' }}>{d.motivo}</div>}
                        {d.chave && <div className="hint" style={{ fontFamily: 'monospace', fontSize: '0.72rem' }}>{d.chave}</div>}
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                          {podeReenviar && (
                            <button className="btn btn-outline btn-sm" disabled={busyId === d.id} onClick={() => handleReprocess(d)}>
                              <RefreshCw size={14} /> Reenviar
                            </button>
                          )}
                          {podeCancelar && (
                            <button className="btn btn-danger-soft btn-sm" disabled={busyId === d.id} onClick={() => { setCancelDoc(d); setJustificativa(''); }}>
                              <XCircle size={14} /> Cancelar
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {cancelDoc && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="cancel-title">
          <form onSubmit={handleCancel} className="modal card card-pad" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div className="modal-head">
              <h2 id="cancel-title" className="section-title">Cancelar nota {cancelDoc.numero}</h2>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCancelDoc(null)} aria-label="Fechar"><X size={18} /></button>
            </div>
            <p className="hint">O cancelamento é enviado à SEFAZ e só é aceito até 30 minutos após a autorização.</p>
            <div className="field">
              <label className="label" htmlFor="cancel-just">Justificativa (mínimo 15 caracteres)</label>
              <textarea id="cancel-just" className="input" value={justificativa} onChange={e => setJustificativa(e.target.value)} maxLength={255} required autoFocus />
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-outline" onClick={() => setCancelDoc(null)}>Voltar</button>
              <button type="submit" className="btn btn-danger" disabled={busyId === cancelDoc.id}><XCircle size={16} /> Cancelar na SEFAZ</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
