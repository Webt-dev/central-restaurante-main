import React, { useState, useEffect, useMemo, useRef } from 'react';
import type { Table, MenuItem } from '../types';
import { api } from '../services/api';
import { socket } from '../services/socket';
import { offlineDb } from '../services/offlineDb';
import { useServiceTaxPercent, calcServiceTax, formatPercent } from '../services/settings';
import { useIsMobile } from '../hooks/useIsMobile';
import {
  ShoppingBag, Plus, Minus, Send, CheckCircle2, AlertCircle, Search, RefreshCw,
  X, UserPlus, DoorOpen, LayoutGrid, Utensils, ArrowLeft, Trash2
} from 'lucide-react';

interface WaiterScreenProps {
  isOnline: boolean;
  onOrderCreated: () => void;
}

interface CartItem {
  menuItem: MenuItem;
  quantity: number;
  notes: string;
}

type MobileStep = 'TABLES' | 'MENU' | 'CART';

const INITIAL_TABLES: Table[] = Array.from({ length: 10 }, (_, i) => ({
  id: `t${i + 1}`,
  number: i + 1,
  name: `Mesa ${i + 1}`,
  status: 'FREE'
}));

export const WaiterScreen: React.FC<WaiterScreenProps> = ({ isOnline, onOrderCreated }) => {
  const taxPercent = useServiceTaxPercent();
  const isMobile = useIsMobile();

  const [tables, setTables] = useState<Table[]>(INITIAL_TABLES);
  const [menuItems, setMenuItems] = useState<MenuItem[]>([]);
  const [selectedTable, setSelectedTable] = useState<Table | null>(null);
  const [activeCategory, setActiveCategory] = useState<string>('Todos');
  const [cart, setCart] = useState<CartItem[]>([]);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);
  const [changingTable, setChangingTable] = useState<boolean>(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const [step, setStep] = useState<MobileStep>('TABLES');
  const [menuState, setMenuState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [menuError, setMenuError] = useState<string>('');

  useEffect(() => {
    carregarDados();
    if (socket) {
      socket.on('table:status_changed', carregarMesas);
      socket.on('tables:updated', carregarMesas);
      socket.on('menu:updated', carregarCardapio);
    }
    return () => {
      if (socket) {
        socket.off('table:status_changed', carregarMesas);
        socket.off('tables:updated', carregarMesas);
        socket.off('menu:updated', carregarCardapio);
      }
    };
  }, []);

  async function carregarDados() {
    await Promise.all([carregarMesas(), carregarCardapio()]);
  }

  async function carregarMesas() {
    try {
      const tData = await api.getTables();
      if (tData && tData.length > 0) {
        setTables(tData);
        setSelectedTable(prev => (prev ? tData.find(t => t.id === prev.id) || prev : prev));
      }
    } catch (err) {
      console.warn('Erro ao carregar mesas:', err);
    }
  }

  async function carregarCardapio(tentativa = 1) {
    if (tentativa === 1) setMenuState(prev => (prev === 'ready' ? 'ready' : 'loading'));
    try {
      const mData = await api.getMenuItems();
      if ((!mData || mData.length === 0) && tentativa < 3) {
        await new Promise(r => setTimeout(r, 400 * tentativa));
        return carregarCardapio(tentativa + 1);
      }
      setMenuItems(mData || []);
      setMenuState('ready');
      setMenuError('');
    } catch (err: any) {
      if (tentativa < 3) {
        await new Promise(r => setTimeout(r, 400 * tentativa));
        return carregarCardapio(tentativa + 1);
      }
      setMenuState('error');
      setMenuError(err?.message || 'Não foi possível carregar o cardápio.');
    }
  }

  async function handleOccupyTable(table: Table) {
    setChangingTable(true);
    setFeedback(null);
    try {
      await api.updateTableStatus(table.id, 'OCCUPIED');
      setTables(prev => prev.map(t => (t.id === table.id ? { ...t, status: 'OCCUPIED' } : t)));
      setSelectedTable({ ...table, status: 'OCCUPIED' });
      setFeedback({ type: 'success', message: `${table.name} ocupada.` });
    } catch (err: any) {
      setFeedback({ type: 'error', message: err.message || 'Não foi possível ocupar a mesa.' });
    } finally {
      setChangingTable(false);
    }
  }

  async function handleFreeTable(table: Table) {
    setChangingTable(true);
    setFeedback(null);
    try {
      const bill = await api.getTableBill(table.id).catch(() => null);
      if (bill && bill.orders && bill.orders.length > 0) {
        setFeedback({
          type: 'error',
          message: `A ${table.name} tem consumo em aberto (R$ ${Number(bill.total_amount || 0).toFixed(2)}). Feche no caixa antes de liberar.`
        });
        return;
      }
      if (!window.confirm(`Liberar a ${table.name}?`)) return;

      await api.updateTableStatus(table.id, 'FREE');
      setTables(prev => prev.map(t => (t.id === table.id ? { ...t, status: 'FREE' } : t)));
      setSelectedTable({ ...table, status: 'FREE' });
      setFeedback({ type: 'success', message: `${table.name} liberada.` });
    } catch (err: any) {
      setFeedback({ type: 'error', message: err.message || 'Não foi possível liberar a mesa.' });
    } finally {
      setChangingTable(false);
    }
  }

  function selecionarMesa(t: Table) {
    setSelectedTable(t);
    setFeedback(null);
    if (isMobile) setStep('MENU');
  }

  const categories = useMemo(
    () => ['Todos', ...Array.from(new Set(menuItems.map(i => i.category)))],
    [menuItems]
  );

  const filteredMenuItems = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    return menuItems.filter(item => {
      const okCat = activeCategory === 'Todos' || item.category === activeCategory;
      const okBusca = !q || item.name.toLowerCase().includes(q) || (item.description || '').toLowerCase().includes(q);
      return okCat && okBusca;
    });
  }, [menuItems, activeCategory, searchQuery]);

  const lastClickTimeRef = useRef<{ [key: string]: number }>({});

  function addToCart(item: MenuItem) {
    const now = Date.now();
    if (now - (lastClickTimeRef.current[item.id] || 0) < 50) return;
    lastClickTimeRef.current[item.id] = now;

    setCart(prev => {
      const idx = prev.findIndex(c => c.menuItem.id === item.id);
      if (idx > -1) return prev.map((c, i) => (i === idx ? { ...c, quantity: c.quantity + 1 } : c));
      return [...prev, { menuItem: item, quantity: 1, notes: '' }];
    });
  }

  function updateQuantity(itemId: string, delta: number) {
    setCart(prev =>
      prev
        .map(c => {
          if (c.menuItem.id !== itemId) return c;
          const q = c.quantity + delta;
          return q > 0 ? { ...c, quantity: q } : null;
        })
        .filter(Boolean) as CartItem[]
    );
  }

  function updateNotes(itemId: string, notes: string) {
    setCart(prev => prev.map(c => (c.menuItem.id === itemId ? { ...c, notes } : c)));
  }

  function qtyNoCarrinho(itemId: string): number {
    return cart.find(c => c.menuItem.id === itemId)?.quantity || 0;
  }

  const cartTotal = cart.reduce((acc, i) => acc + i.menuItem.price * i.quantity, 0);
  const cartItemCount = cart.reduce((acc, i) => acc + i.quantity, 0);
  const suggestedTax = calcServiceTax(cartTotal, taxPercent);

  async function handleSendOrder() {
    if (!selectedTable) {
      setFeedback({ type: 'error', message: 'Escolha uma mesa antes de enviar o pedido.' });
      if (isMobile) setStep('TABLES');
      return;
    }
    if (cart.length === 0) {
      setFeedback({ type: 'error', message: 'Adicione pelo menos um item ao pedido.' });
      return;
    }

    setLoading(true);
    setFeedback(null);

    const items = cart.map(c => ({
      menu_item_id: c.menuItem.id,
      quantity: c.quantity,
      notes: c.notes || undefined
    }));
    const syncId = `off_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

    try {
      if (isOnline) {
        await api.createOrder(selectedTable.id, items, syncId);
        setFeedback({ type: 'success', message: `Pedido da ${selectedTable.name} enviado para a produção.` });
      } else {
        if (offlineDb) {
          await offlineDb.offlineOrders.add({
            offline_sync_id: syncId,
            table_id: selectedTable.id,
            table_number: selectedTable.number,
            items,
            notes: '',
            created_at: new Date().toISOString(),
            synced: 0
          });
        }
        setFeedback({ type: 'success', message: 'Sem conexão: o pedido foi salvo e será enviado automaticamente.' });
      }

      setCart([]);
      onOrderCreated();
      carregarMesas();
      if (isMobile) setStep('TABLES');
    } catch (err: any) {
      setFeedback({ type: 'error', message: err.message || 'Não foi possível enviar o pedido.' });
    } finally {
      setLoading(false);
    }
  }

  const freeCount = tables.filter(t => t.status === 'FREE').length;

  // ======================================================== BLOCOS DE TELA

  const blocoFeedback = feedback && (
    <div className={`alert ${feedback.type === 'success' ? 'alert-success' : 'alert-error'}`}>
      {feedback.type === 'success' ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
      {feedback.message}
    </div>
  );

  const blocoMesas = (
    <div className="card card-pad">
      <div className="card-head">
        <div>
          <h2>Mesas</h2>
          <div className="hint">{freeCount} de {tables.length} livres</div>
        </div>
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          <span className="badge badge-free">Livre</span>
          <span className="badge badge-occupied">Ocupada</span>
          <span className="badge badge-pending">Pagamento</span>
        </div>
      </div>

      {/* Rolagem própria também no celular */}
      <div className="table-grid scroll-area scroll-tables-grid">
        {tables.map(t => (
          <button
            key={t.id}
            onClick={() => selecionarMesa(t)}
            onDoubleClick={() => (!isMobile && (t.status === 'FREE' ? handleOccupyTable(t) : handleFreeTable(t)))}
            className={`table-chip ${selectedTable?.id === t.id ? 'is-active' : ''} status-${String(t.status).toLowerCase()}`}
          >
            <span className="table-chip-num">{t.number}</span>
            <span className="table-chip-status">
              {t.status === 'FREE' ? 'Livre' : t.status === 'OCCUPIED' ? 'Ocupada' : 'Pagando'}
            </span>
          </button>
        ))}
      </div>

      {selectedTable && (
        <div className="table-actions">
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: '0.92rem' }}>{selectedTable.name}</div>
            <div className="hint">
              {selectedTable.status === 'FREE' ? 'Marque como ocupada quando o cliente sentar.' : 'Em atendimento.'}
            </div>
          </div>

          <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
            {selectedTable.status === 'FREE' ? (
              <button onClick={() => handleOccupyTable(selectedTable)} disabled={changingTable} className="btn btn-primary btn-sm">
                <UserPlus size={15} /> Ocupar
              </button>
            ) : (
              <button onClick={() => handleFreeTable(selectedTable)} disabled={changingTable} className="btn btn-outline btn-sm">
                <DoorOpen size={15} /> Liberar
              </button>
            )}
            {isMobile && (
              <button onClick={() => setStep('MENU')} className="btn btn-success btn-sm">
                <Utensils size={15} /> Pedir
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );

  const blocoCardapio = (
    <div className="card card-pad">
      <div className="card-head">
        <h2>Cardápio</h2>
        <div className="input-group" style={{ maxWidth: isMobile ? 'none' : '260px' }}>
          <span className="input-icon"><Search size={16} /></span>
          <input
            type="text"
            placeholder="Buscar produto"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="input"
            disabled={menuState !== 'ready'}
          />
          {searchQuery && (
            <button onClick={() => setSearchQuery('')} className="input-clear" title="Limpar busca"><X size={15} /></button>
          )}
        </div>
      </div>

      {menuState === 'loading' && (
        <div className="empty-state" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px' }}>
          <RefreshCw size={26} className="spin" color="var(--text-muted)" />
          Carregando o cardápio...
        </div>
      )}

      {menuState === 'error' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div className="alert alert-error"><AlertCircle size={17} /> {menuError}</div>
          <button onClick={() => carregarCardapio()} className="btn btn-primary">
            <RefreshCw size={16} /> Tentar novamente
          </button>
        </div>
      )}

      {menuState === 'ready' && (
        <>
          <div className="filter-scroll" style={{ marginBottom: '10px' }}>
            {categories.map(cat => (
              <button
                key={cat}
                onClick={() => setActiveCategory(cat)}
                className={`btn btn-sm ${activeCategory === cat ? 'btn-primary' : 'btn-outline'}`}
              >
                {cat}
              </button>
            ))}
          </div>

          <div className="list-meta">
            <span>
              {filteredMenuItems.length} produto{filteredMenuItems.length === 1 ? '' : 's'}
              {activeCategory !== 'Todos' ? ` em ${activeCategory}` : ''}
            </span>
          </div>

          {/* Rolagem própria também no celular: a página não estica */}
          <div className="menu-grid scroll-area scroll-menu">
            {filteredMenuItems.map(item => {
              const qtd = qtyNoCarrinho(item.id);
              return (
                <div key={item.id} className={`menu-card ${qtd > 0 ? 'has-qty' : ''}`}>
                  {/* Área de toque para adicionar */}
                  <button className="menu-card-add" onClick={() => addToCart(item)} title={`Adicionar ${item.name}`}>
                    <span className="menu-card-cat">{item.category}</span>
                    <span className="menu-card-name">{item.name}</span>
                    <span className="menu-card-price">R$ {item.price.toFixed(2)}</span>
                  </button>

                  {/* Controles de quantidade, direto no cardápio */}
                  {qtd > 0 ? (
                    <div className="menu-card-stepper">
                      <button onClick={() => updateQuantity(item.id, -1)} title="Remover um">
                        <Minus size={16} />
                      </button>
                      <span>{qtd}</span>
                      <button onClick={() => addToCart(item)} title="Adicionar um">
                        <Plus size={16} />
                      </button>
                    </div>
                  ) : (
                    <button className="menu-card-plus" onClick={() => addToCart(item)}>
                      <Plus size={15} /> Adicionar
                    </button>
                  )}
                </div>
              );
            })}

            {filteredMenuItems.length === 0 && (
              <div className="empty-state" style={{ gridColumn: '1 / -1' }}>
                {menuItems.length === 0
                  ? 'Nenhum produto cadastrado. Adicione itens em Gestão > Cardápio.'
                  : 'Nenhum produto encontrado com esse filtro.'}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );

  const blocoComanda = (
    <div className="card card-pad" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div className="card-head" style={{ marginBottom: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
          <ShoppingBag size={18} color="var(--text-secondary)" />
          <div style={{ minWidth: 0 }}>
            <h2>Comanda</h2>
            <div className="hint">{selectedTable ? `Para ${selectedTable.name}` : 'Selecione uma mesa'}</div>
          </div>
        </div>
        {cart.length > 0 && (
          <button onClick={() => setCart([])} className="btn btn-danger-soft btn-sm">
            <Trash2 size={14} /> Limpar
          </button>
        )}
      </div>

      {!isMobile && blocoFeedback}

      <div className="scroll-area scroll-cart" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {cart.length === 0 ? (
          <div className="empty-state">Toque nos produtos do cardápio para montar o pedido.</div>
        ) : (
          cart.map(c => (
            <div key={c.menuItem.id} className="cart-line">
              <div className="cart-line-head">
                <div style={{ minWidth: 0 }}>
                  <div className="cart-line-name">{c.menuItem.name}</div>
                  <div className="hint">R$ {c.menuItem.price.toFixed(2)} cada</div>
                </div>
                <span className="money">R$ {(c.menuItem.price * c.quantity).toFixed(2)}</span>
              </div>

              <div className="cart-line-controls">
                <input
                  type="text"
                  placeholder="Observação (ex.: sem cebola)"
                  value={c.notes}
                  onChange={e => updateNotes(c.menuItem.id, e.target.value)}
                  className="input"
                  style={{ flex: 1, minWidth: 0 }}
                />
                <div className="stepper">
                  <button onClick={() => updateQuantity(c.menuItem.id, -1)} title="Diminuir"><Minus size={16} /></button>
                  <span>{c.quantity}</span>
                  <button onClick={() => updateQuantity(c.menuItem.id, 1)} title="Aumentar"><Plus size={16} /></button>
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      <div style={{ borderTop: '1px solid var(--border)', paddingTop: '10px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
        <div className="summary-row">
          <span>Consumo</span>
          <span className="money">R$ {cartTotal.toFixed(2)}</span>
        </div>
        {taxPercent > 0 && (
          <div className="summary-row">
            <span>Taxa sugerida ({formatPercent(taxPercent)}%)</span>
            <span className="money">+ R$ {suggestedTax.toFixed(2)}</span>
          </div>
        )}
        <div className="summary-total">
          <span className="label-total">Total estimado</span>
          <span className="value-total">R$ {(cartTotal + suggestedTax).toFixed(2)}</span>
        </div>
        <span className="hint">A taxa é confirmada no caixa, junto com o cliente.</span>

        <button
          onClick={handleSendOrder}
          disabled={loading || cart.length === 0}
          className="btn btn-success btn-block btn-lg"
          style={{ marginTop: '4px' }}
        >
          <Send size={16} /> {loading ? 'Enviando...' : 'Enviar pedido'}
        </button>
      </div>
    </div>
  );

  // ============================================================== COMPUTADOR
  if (!isMobile) {
    return (
      <div className="page">
        {blocoFeedback}
        <div className="split-layout">
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {blocoMesas}
            {blocoCardapio}
          </div>
          {blocoComanda}
        </div>
      </div>
    );
  }

  // ================================================================= CELULAR
  return (
    <div className="page waiter-mobile">
      <div className="step-bar">
        <button onClick={() => setStep('TABLES')} className={step === 'TABLES' ? 'is-active' : ''}>
          <LayoutGrid size={16} />
          Mesas
        </button>
        <button onClick={() => setStep('MENU')} className={step === 'MENU' ? 'is-active' : ''}>
          <Utensils size={16} />
          Cardápio
        </button>
        <button onClick={() => setStep('CART')} className={step === 'CART' ? 'is-active' : ''}>
          <ShoppingBag size={16} />
          Comanda
          {cartItemCount > 0 && <span className="step-badge">{cartItemCount}</span>}
        </button>
      </div>

      {selectedTable && step !== 'TABLES' && (
        <button onClick={() => setStep('TABLES')} className="current-table">
          <ArrowLeft size={15} />
          <span><strong>{selectedTable.name}</strong> · trocar</span>
          <span className={`badge ${selectedTable.status === 'FREE' ? 'badge-free' : selectedTable.status === 'OCCUPIED' ? 'badge-occupied' : 'badge-pending'}`}>
            {selectedTable.status === 'FREE' ? 'Livre' : selectedTable.status === 'OCCUPIED' ? 'Ocupada' : 'Pagando'}
          </span>
        </button>
      )}

      {blocoFeedback}

      {step === 'TABLES' && blocoMesas}
      {step === 'MENU' && blocoCardapio}
      {step === 'CART' && blocoComanda}

      {cartItemCount > 0 && step !== 'CART' && (
        <button onClick={() => setStep('CART')} className="cart-bar">
          <span>
            <ShoppingBag size={17} />
            {cartItemCount} {cartItemCount === 1 ? 'item' : 'itens'}
          </span>
          <span>R$ {cartTotal.toFixed(2)} · ver comanda</span>
        </button>
      )}
    </div>
  );
};
