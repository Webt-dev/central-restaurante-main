import React, { useState, useEffect, useCallback } from 'react';
import type { Order, OrderItem } from '../types';
import { api } from '../services/api';
import { socket } from '../services/socket';
import { Clock, CheckCircle2, AlertCircle, ChefHat, GlassWater, RotateCcw, RefreshCw } from 'lucide-react';

interface KitchenScreenProps {
  type?: 'FOOD' | 'BAR';
}

type QueueFilter = 'TODO' | 'DONE';

function hojeStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Guarda local dos pedidos concluídos.
 *
 * MOTIVO: a fila do backend (/kitchen/queue) devolve apenas pedidos em aberto.
 * Assim que o pedido é marcado como pronto, ele some da resposta — por isso a
 * aba "Prontos" aparecia sempre vazia. Mantemos aqui uma cópia do pedido
 * concluído, válida para o dia corrente, para que a equipe possa conferir e
 * desfazer. A chave inclui o dia e o setor (cozinha ou bar).
 */
function chaveArmazenamento(type: string): string {
  return `kds_prontos_${type}_${hojeStr()}`;
}

function lerProntosSalvos(type: string): Order[] {
  try {
    const bruto = localStorage.getItem(chaveArmazenamento(type));
    if (!bruto) return [];
    const dados = JSON.parse(bruto);
    return Array.isArray(dados) ? dados : [];
  } catch {
    return [];
  }
}

function salvarProntos(type: string, pedidos: Order[]): void {
  try {
    localStorage.setItem(chaveArmazenamento(type), JSON.stringify(pedidos));
    // Limpa registros de dias anteriores
    const prefixo = `kds_prontos_${type}_`;
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith(prefixo) && k !== chaveArmazenamento(type)) {
        localStorage.removeItem(k);
      }
    }
  } catch {
    // Sem espaço ou modo privativo: segue sem persistir.
  }
}

export const KitchenScreen: React.FC<KitchenScreenProps> = ({ type = 'FOOD' }) => {
  const [orders, setOrders] = useState<Order[]>([]);
  const [prontos, setProntos] = useState<Order[]>(() => lerProntosSalvos(type));
  const [loading, setLoading] = useState<boolean>(true);
  const [busyOrders, setBusyOrders] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState<QueueFilter>('TODO');
  const [error, setError] = useState<string | null>(null);
  const isBar = type === 'BAR';

  const loadQueue = useCallback(async () => {
    try {
      const data = isBar ? await api.getBarQueue() : await api.getKitchenQueue();
      setOrders(Array.isArray(data) ? data : []);
      setError(null);
    } catch (err: any) {
      setError(err.message || 'Não foi possível carregar a fila.');
    } finally {
      setLoading(false);
    }
  }, [isBar]);

  useEffect(() => {
    setProntos(lerProntosSalvos(type));
    setFilter('TODO');
    loadQueue();

    if (socket) {
      socket.on('order:created', loadQueue);
      socket.on('order:status_changed', loadQueue);
    }
    const poll = setInterval(loadQueue, 20000);

    return () => {
      clearInterval(poll);
      if (socket) {
        socket.off('order:created', loadQueue);
        socket.off('order:status_changed', loadQueue);
      }
    };
  }, [type, loadQueue]);

  function isItemDone(item: OrderItem): boolean {
    return item.status === 'READY' || item.status === 'DELIVERED';
  }

  function isOrderDone(order: Order): boolean {
    const items = order.items || [];
    return items.length > 0 && items.every(isItemDone);
  }

  /** Marca o pedido inteiro como pronto e o move para a aba Prontos. */
  async function concluirPedido(order: Order) {
    setBusyOrders(prev => ({ ...prev, [order.id]: true }));
    setError(null);

    // Some da fila imediatamente e já aparece em Prontos.
    const concluido: Order = {
      ...order,
      items: (order.items || []).map(it => ({ ...it, status: 'READY' as const }))
    };
    setOrders(prev => prev.filter(o => o.id !== order.id));
    setProntos(prev => {
      const novo = [concluido, ...prev.filter(o => o.id !== order.id)];
      salvarProntos(type, novo);
      return novo;
    });

    try {
      await api.updateOrderBatchStatus(order.id, 'READY', type);
      await loadQueue();
    } catch (err: any) {
      setError(err.message || 'Não foi possível concluir o pedido. Ele voltou para a fila.');
      // Desfaz a mudança local se o servidor recusou.
      setProntos(prev => {
        const novo = prev.filter(o => o.id !== order.id);
        salvarProntos(type, novo);
        return novo;
      });
      await loadQueue();
    } finally {
      setBusyOrders(prev => {
        const next = { ...prev };
        delete next[order.id];
        return next;
      });
    }
  }

  /** Devolve o pedido para a fila. */
  async function desfazerPedido(order: Order) {
    setBusyOrders(prev => ({ ...prev, [order.id]: true }));
    setError(null);

    setProntos(prev => {
      const novo = prev.filter(o => o.id !== order.id);
      salvarProntos(type, novo);
      return novo;
    });

    try {
      await api.updateOrderBatchStatus(order.id, 'PENDING', type);
      await loadQueue();
      setFilter('TODO');
    } catch (err: any) {
      setError(err.message || 'Não foi possível desfazer. Tente novamente.');
      setProntos(prev => {
        const novo = [order, ...prev];
        salvarProntos(type, novo);
        return novo;
      });
    } finally {
      setBusyOrders(prev => {
        const next = { ...prev };
        delete next[order.id];
        return next;
      });
    }
  }

  function getTimeElapsed(createdAt: string): string {
    const minutos = Math.floor((Date.now() - new Date(createdAt).getTime()) / 60000);
    if (minutos < 1) return 'Agora mesmo';
    if (minutos < 60) return `Há ${minutos} min`;
    const horas = Math.floor(minutos / 60);
    return `Há ${horas}h${String(minutos % 60).padStart(2, '0')}`;
  }

  // A fila do backend pode trazer pedidos já prontos; removemos para não duplicar.
  const idsProntos = new Set(prontos.map(o => o.id));
  const pedidosAFazer = orders.filter(o => !isOrderDone(o) && !idsProntos.has(o.id));
  const visibleOrders = filter === 'TODO' ? pedidosAFazer : prontos;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {isBar ? <GlassWater size={20} color="var(--text-secondary)" /> : <ChefHat size={20} color="var(--text-secondary)" />}
            <span className="kds-tv-title">{isBar ? 'Bar' : 'Cozinha'}</span>
          </h1>
          <div className="page-subtitle">
            Toque em "Pedido pronto" quando terminar todos os itens da mesa.
          </div>
        </div>
        <button onClick={loadQueue} className="btn btn-outline btn-sm">
          <RefreshCw size={15} /> Atualizar
        </button>
      </div>

      {error && (
        <div className="alert alert-error">
          <AlertCircle size={17} /> {error}
        </div>
      )}

      <div className="segmented" style={{ maxWidth: '420px' }}>
        <button onClick={() => setFilter('TODO')} className={filter === 'TODO' ? 'is-active' : ''}>
          A fazer ({pedidosAFazer.length})
        </button>
        <button onClick={() => setFilter('DONE')} className={filter === 'DONE' ? 'is-active' : ''}>
          Prontos ({prontos.length})
        </button>
      </div>

      {filter === 'DONE' && prontos.length > 0 && (
        <div className="alert alert-info">
          <AlertCircle size={16} />
          Os pedidos ficam aqui até o fim do dia. Use "Desfazer" se algum foi marcado por engano.
        </div>
      )}

      {loading ? (
        <div className="empty-state">Carregando pedidos...</div>
      ) : visibleOrders.length === 0 ? (
        <div className="card card-pad empty-state">
          <CheckCircle2 size={38} color="var(--green)" style={{ marginBottom: '10px' }} />
          <h2>{filter === 'TODO' ? 'Tudo pronto!' : 'Nenhum pedido concluído hoje'}</h2>
          <p className="hint" style={{ marginTop: '4px' }}>
            {filter === 'TODO'
              ? isBar ? 'Não há bebidas na fila.' : 'Não há pratos na fila.'
              : 'Os pedidos concluídos aparecem aqui.'}
          </p>
        </div>
      ) : (
        <div className="kds-grid">
          {visibleOrders.map(order => {
            const concluido = filter === 'DONE';
            const ocupado = !!busyOrders[order.id];
            const itens = order.items || [];
            const totalItens = itens.reduce((acc, i) => acc + i.quantity, 0);

            return (
              <div
                key={order.id}
                className={`card card-pad animate-fade-in kds-order ${concluido ? 'is-done' : ''}`}
              >
                <div className="kds-order-head">
                  <div style={{ minWidth: 0 }}>
                    <div className="kds-order-table">
                      Mesa {order.table_number || order.table_id}
                    </div>
                    <div className="kds-order-meta">
                      {order.waiter_name || 'Garçom'} · {totalItens} {totalItens === 1 ? 'item' : 'itens'}
                    </div>
                  </div>
                  <span className={`badge ${concluido ? 'badge-free' : 'badge-pending'}`}>
                    <Clock size={13} /> {getTimeElapsed(order.created_at)}
                  </span>
                </div>

                <ul className="kds-list">
                  {itens.map(item => (
                    <li key={item.id} className="kds-line">
                      <span className="kds-line-qty">{item.quantity}x</span>
                      <span className="kds-line-body">
                        <span className="kds-line-name">{item.menu_item_name || 'Item'}</span>
                        {item.notes && (
                          <span className="kds-line-note">
                            <AlertCircle size={13} /> {item.notes}
                          </span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>

                {concluido ? (
                  <button
                    onClick={() => desfazerPedido(order)}
                    disabled={ocupado}
                    className="kds-toggle is-done"
                  >
                    <RotateCcw size={18} /> {ocupado ? 'Aguarde...' : 'Desfazer'}
                  </button>
                ) : (
                  <button
                    onClick={() => concluirPedido(order)}
                    disabled={ocupado}
                    className="kds-toggle"
                  >
                    <CheckCircle2 size={22} /> {ocupado ? 'Salvando...' : 'Pedido pronto'}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
