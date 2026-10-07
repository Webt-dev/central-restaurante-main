import React from 'react';
import { X, RefreshCw, Trash2, AlertTriangle, Clock } from 'lucide-react';
import { useOutbox, flush, retryOrder, discardOrder } from '../services/outbox';

/**
 * Pedidos guardados neste aparelho que ainda não chegaram à central:
 * - "Aguardando envio": sem conexão; saem sozinhos quando a rede voltar.
 * - "Recusado": a central não aceitou (ex.: falta de estoque). O garçom
 *   decide se reenvia ou descarta.
 */
export const PendingOrdersModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const orders = useOutbox();

  function handleDiscard(id: number, tableName: string) {
    if (window.confirm(`Descartar o pedido da ${tableName}? Ele não será enviado para a cozinha.`)) {
      void discardOrder(id);
    }
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="pending-title" onClick={onClose}>
      <div className="modal card card-pad" onClick={e => e.stopPropagation()} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <div className="modal-head">
          <h2 id="pending-title" className="section-title">Pedidos neste aparelho</h2>
          <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Fechar"><X size={18} /></button>
        </div>

        {orders.length === 0 && <p className="hint">Nenhum pedido pendente. Tudo foi entregue à central.</p>}

        {orders.map(o => {
          const tableName = o.table_name || `Mesa ${o.table_number}`;
          return (
            <div key={o.id} className="card card-pad" style={{ boxShadow: 'none', background: 'var(--bg-subtle)', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'center' }}>
                <strong>{tableName}</strong>
                {o.status === 'error'
                  ? <span className="badge badge-occupied"><AlertTriangle size={12} /> Recusado</span>
                  : <span className="badge badge-pending"><Clock size={12} /> Aguardando envio</span>}
              </div>
              <ul style={{ margin: 0, paddingLeft: '18px' }}>
                {o.items.map((i, idx) => <li key={idx}>{i.quantity}× {i.name || i.menu_item_id}{i.notes ? ` — ${i.notes}` : ''}</li>)}
              </ul>
              {o.error && <div className="alert alert-error"><AlertTriangle size={15} /> {o.error}</div>}
              <div className="hint">Lançado às {new Date(o.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</div>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                {o.status === 'error' && (
                  <button className="btn btn-outline btn-sm" onClick={() => void retryOrder(o.id!)}><RefreshCw size={14} /> Tentar de novo</button>
                )}
                <button className="btn btn-danger-soft btn-sm" onClick={() => handleDiscard(o.id!, tableName)}><Trash2 size={14} /> Descartar</button>
              </div>
            </div>
          );
        })}

        {orders.some(o => o.status === 'pending') && (
          <button className="btn btn-primary btn-block" onClick={() => void flush()}><RefreshCw size={16} /> Enviar agora</button>
        )}
      </div>
    </div>
  );
};
