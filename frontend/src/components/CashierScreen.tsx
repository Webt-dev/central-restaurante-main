import React, { useState, useEffect } from 'react';
import type { Table } from '../types';
import { api } from '../services/api';
import { formatDateTimeBR } from '../utils/dateUtils';
import { printReceiptContent } from '../utils/printUtils';
import { useSettings, useServiceTaxPercent, calcServiceTax, formatPercent } from '../services/settings';
import {
  DollarSign, CreditCard, QrCode, Receipt, CheckCircle2, AlertCircle, RefreshCw,
  Printer, X, Plus, Minus, Trash2, Layers, Clock, ShieldCheck, Pencil, Wand2
} from 'lucide-react';

type PaymentMethodType = 'CASH' | 'CREDIT_CARD' | 'DEBIT_CARD' | 'PIX';

interface SplitPaymentRow {
  id: string;
  method: PaymentMethodType;
  amount: number;
}

const METHOD_LABELS: Record<PaymentMethodType, string> = {
  PIX: 'PIX',
  CASH: 'Dinheiro',
  CREDIT_CARD: 'Cartão de crédito',
  DEBIT_CARD: 'Cartão de débito'
};

const METHOD_ICONS: Record<PaymentMethodType, React.ReactNode> = {
  PIX: <QrCode size={16} />,
  CASH: <DollarSign size={16} />,
  CREDIT_CARD: <CreditCard size={16} />,
  DEBIT_CARD: <CreditCard size={16} />
};

function money(v: number): number {
  return Math.round((Number(v) || 0) * 100) / 100;
}

export const CashierScreen: React.FC = () => {
  const settings = useSettings();
  const taxPercent = useServiceTaxPercent();

  const allowedMethods = React.useMemo<PaymentMethodType[]>(() => {
    const raw = Array.isArray(settings.payment_methods_allowed) ? settings.payment_methods_allowed : [];
    const list = (['CASH', 'PIX', 'CREDIT_CARD', 'DEBIT_CARD'] as PaymentMethodType[])
      .filter(m => m === 'CASH' || raw.includes(m));
    return list.length > 0 ? list : ['CASH'];
  }, [settings.payment_methods_allowed]);

  const [tables, setTables] = useState<Table[]>([]);
  const [selectedTable, setSelectedTable] = useState<Table | null>(null);
  const [bill, setBill] = useState<any | null>(null);
  const [closedHistory, setClosedHistory] = useState<any[]>([]);

  const [includeTip, setIncludeTip] = useState<boolean>(false);
  const [viewMode, setViewMode] = useState<'ITEMS' | 'TIMELINE'>('ITEMS');
  const [isSplitMode, setIsSplitMode] = useState<boolean>(false);

  const [singleMethod, setSingleMethod] = useState<PaymentMethodType>('CASH');
  const [singleAmountPaid, setSingleAmountPaid] = useState<string>('');
  const [splitRows, setSplitRows] = useState<SplitPaymentRow[]>([]);

  const [showVerifyModal, setShowVerifyModal] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [receiptText, setReceiptText] = useState<string | null>(null);

  useEffect(() => {
    loadTables();
    loadClosedHistory();
  }, []);

  useEffect(() => {
    if (!allowedMethods.includes(singleMethod)) setSingleMethod(allowedMethods[0]!);
    setSplitRows(prev => prev.map(r => (allowedMethods.includes(r.method) ? r : { ...r, method: allowedMethods[0]! })));
  }, [allowedMethods]);

  async function loadTables() {
    try {
      setTables(await api.getTables());
    } catch (err) {
      console.error('Erro ao carregar mesas:', err);
    }
  }

  async function loadClosedHistory() {
    try {
      const rData = await api.getDailyReport();
      if (rData && rData.table_orders_detail) setClosedHistory(rData.table_orders_detail);
    } catch (err) {
      console.warn('Erro ao carregar histórico de fechamentos:', err);
    }
  }

  async function refreshCurrentBill(tableId: string, tipEnabled = includeTip) {
    try {
      const bData = await api.getTableBill(tableId);
      setBill(bData);
      const subtotal = bData?.total_amount || 0;
      const targetVal = money(subtotal + (tipEnabled ? calcServiceTax(subtotal, taxPercent) : 0));
      setSingleAmountPaid(targetVal.toString());
      setSplitRows([{ id: '1', method: allowedMethods[0]!, amount: targetVal }]);
    } catch {
      setBill(null);
      setSplitRows([]);
    }
  }

  async function handleSelectTable(t: Table) {
    setSelectedTable(t);
    setFeedback(null);
    setIsSplitMode(false);
    setShowVerifyModal(false);
    setIncludeTip(false);
    await refreshCurrentBill(t.id, false);
  }

  async function handleDeleteItem(itemId: string) {
    if (!selectedTable) return;
    if (!window.confirm('Remover este item da comanda?')) return;
    try {
      await api.deleteOrderItem(itemId);
      await refreshCurrentBill(selectedTable.id);
      loadTables();
    } catch (err: any) {
      alert(`Não foi possível remover o item: ${err.message}`);
    }
  }

  async function handleUpdateQuantity(itemId: string, newQuantity: number) {
    if (!selectedTable) return;
    try {
      await api.updateOrderItemQuantity(itemId, newQuantity);
      await refreshCurrentBill(selectedTable.id);
      loadTables();
    } catch (err: any) {
      alert(`Não foi possível alterar a quantidade: ${err.message}`);
    }
  }

  async function handleReprintReceipt(orderId: string) {
    try {
      const res = await api.reprintReceipt(orderId);
      if (res.receipt_text) setReceiptText(res.receipt_text);
    } catch (err: any) {
      alert(`Não foi possível reemitir o cupom: ${err.message}`);
    }
  }

  async function handlePrintPreBill(tableId: string) {
    try {
      const res = await api.printTableBill(tableId);
      if (res.receipt_text) setReceiptText(res.receipt_text);
    } catch (err: any) {
      alert(`Não foi possível gerar a pré-conta: ${err.message}`);
    }
  }

  const subtotalAmount = bill?.total_amount || 0;
  const taxEnabled = taxPercent > 0;
  const potentialTip = calcServiceTax(subtotalAmount, taxPercent);
  const tipAmount = includeTip && taxEnabled ? potentialTip : 0;
  const finalTotalAmount = money(subtotalAmount + tipAmount);

  const singlePaid = parseFloat(singleAmountPaid) || finalTotalAmount;
  const singleChange = singleMethod === 'CASH' && singlePaid > finalTotalAmount
    ? money(singlePaid - finalTotalAmount)
    : 0;

  // ------------------------- Pagamento dividido ------------------------------
  //
  // Simplificado: o campo de valor da linha de DINHEIRO é o que o cliente
  // entregou. O balão "Recebido em dinheiro" foi removido — era um segundo
  // campo para a mesma informação e confundia o operador.
  //
  // Excesso em dinheiro vira troco. Excesso em PIX/cartão não existe: precisa
  // ser corrigido, porque não se devolve troco de transferência.

  const totalAllocated = money(splitRows.reduce((acc, r) => acc + (Number(r.amount) || 0), 0));
  const remainingToAllocate = money(Math.max(0, finalTotalAmount - totalAllocated));

  const totalCash = money(
    splitRows.filter(r => r.method === 'CASH').reduce((acc, r) => acc + (Number(r.amount) || 0), 0)
  );
  const totalNonCash = money(totalAllocated - totalCash);

  const excedenteEletronico = money(Math.max(0, totalNonCash - finalTotalAmount));
  const parteEmDinheiro = money(Math.max(0, finalTotalAmount - Math.min(totalNonCash, finalTotalAmount)));
  const totalSplitChange = money(Math.max(0, totalCash - parteEmDinheiro));

  const podeFechar = remainingToAllocate <= 0.009 && excedenteEletronico <= 0.009;

  function handleToggleTip(checked: boolean) {
    setIncludeTip(checked);
    const targetVal = money(subtotalAmount + (checked ? potentialTip : 0));
    if (singleMethod === 'CASH' || !singleAmountPaid) setSingleAmountPaid(targetVal.toString());
    if (splitRows.length === 1) {
      setSplitRows([{ id: splitRows[0]!.id, method: splitRows[0]!.method, amount: targetVal }]);
    }
  }

  function handleAddSplitRow() {
    setSplitRows(prev => [...prev, {
      id: Date.now().toString(),
      method: allowedMethods[0]!,
      amount: remainingToAllocate > 0 ? remainingToAllocate : 0
    }]);
  }

  function handleRemoveSplitRow(id: string) {
    if (splitRows.length === 1) return;
    setSplitRows(prev => prev.filter(r => r.id !== id));
  }

  function handleUpdateSplitRow(id: string, field: keyof SplitPaymentRow, value: any) {
    setSplitRows(prev => prev.map(r => (r.id === id ? { ...r, [field]: value } : r)));
  }

  function ajustarExcedente() {
    let sobra = excedenteEletronico;
    if (sobra <= 0) return;

    setSplitRows(prev => {
      const copia = [...prev];
      for (let i = copia.length - 1; i >= 0 && sobra > 0.009; i--) {
        const linha = copia[i]!;
        if (linha.method === 'CASH') continue;
        const desconto = Math.min(linha.amount, sobra);
        copia[i] = { ...linha, amount: money(linha.amount - desconto) };
        sobra = money(sobra - desconto);
      }
      return copia.filter(r => r.amount > 0 || r.method === 'CASH');
    });
  }

  async function handleFinalProcessPayment() {
    if (!selectedTable) return;
    setLoading(true);
    setFeedback(null);
    setShowVerifyModal(false);

    try {
      let paymentsToSend: { method: PaymentMethodType; amount: number; amount_paid?: number }[] = [];

      if (!isSplitMode) {
        paymentsToSend = [{
          method: singleMethod,
          amount: finalTotalAmount,
          amount_paid: singleMethod === 'CASH' ? (singlePaid || finalTotalAmount) : finalTotalAmount
        }];
      } else {
        if (excedenteEletronico > 0.009) {
          throw new Error(
            `Há R$ ${excedenteEletronico.toFixed(2)} a mais em PIX/cartão. Não existe troco nessas formas: ajuste os valores.`
          );
        }
        if (remainingToAllocate > 0.009) {
          throw new Error(`Ainda faltam R$ ${remainingToAllocate.toFixed(2)} para fechar a conta.`);
        }

        // O valor cobrado é limitado ao saldo; em dinheiro, o que passou disso
        // é troco e vai como amount_paid.
        let restante = finalTotalAmount;
        paymentsToSend = splitRows.map(r => {
          const entregue = money(Number(r.amount) || 0);
          const cobrado = money(Math.min(entregue, restante));
          restante = money(restante - cobrado);
          return {
            method: r.method,
            amount: cobrado,
            amount_paid: r.method === 'CASH' ? entregue : cobrado
          };
        }).filter(p => p.amount > 0 || (p.amount_paid || 0) > 0);
      }

      const result = await api.processPayment(selectedTable.id, paymentsToSend, includeTip && taxEnabled);
      if (result.receipt_text) setReceiptText(result.receipt_text);

      const trocoCalculado = isSplitMode ? totalSplitChange : singleChange;
      const troco = result.change_given ?? trocoCalculado;

      setFeedback({
        type: 'success',
        message: `Mesa ${selectedTable.number} fechada.${troco > 0 ? ` Troco: R$ ${troco.toFixed(2)}.` : ''}`
      });

      setSelectedTable(null);
      setBill(null);
      loadTables();
      loadClosedHistory();
    } catch (err: any) {
      setFeedback({ type: 'error', message: err.message || 'Não foi possível processar o pagamento.' });
    } finally {
      setLoading(false);
    }
  }

  const taxLabel = `Taxa de serviço (${formatPercent(taxPercent)}%)`;
  const trocoExibido = isSplitMode ? totalSplitChange : singleChange;

  return (
    <div className="page">
      {/* Conferência */}
      {showVerifyModal && selectedTable && bill && (
        <div className="modal-overlay">
          <div className="modal modal-lg animate-fade-in">
            <div className="modal-head">
              <div>
                <h2>Conferência da mesa {selectedTable.number}</h2>
                <div className="hint">Revise os itens e a taxa de serviço antes de fechar a conta.</div>
              </div>
              <button onClick={() => setShowVerifyModal(false)} className="btn-close"><X size={19} /></button>
            </div>

            <div>
              <h3 style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px', color: 'var(--text-secondary)' }}>
                <Clock size={15} /> Pedidos lançados
              </h3>
              <div className="scroll-area" style={{ display: 'flex', flexDirection: 'column', gap: '10px', maxHeight: '260px' }}>
                {bill.orders?.map((ord: any, idx: number) => (
                  <div key={ord.id} className="card card-pad" style={{ boxShadow: 'none' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', fontWeight: 600, paddingBottom: '6px', marginBottom: '8px', borderBottom: '1px solid var(--border)' }}>
                      <span>Pedido {idx + 1} — {new Date(ord.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span>
                      <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>{ord.waiter_name || 'Equipe'}</span>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      {ord.items?.map((it: any) => (
                        <div key={it.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', flexWrap: 'wrap', fontSize: '0.85rem' }}>
                          <div>
                            <span style={{ fontWeight: 600 }}>{it.quantity}x {it.menu_item_name}</span>
                            {it.notes && <span style={{ fontSize: '0.75rem', color: 'var(--amber)', marginLeft: '6px' }}>({it.notes})</span>}
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <span className="money">R$ {it.total_price.toFixed(2)}</span>
                            <button onClick={() => handleUpdateQuantity(it.id, it.quantity - 1)} className="btn btn-outline btn-sm btn-icon" title="Diminuir"><Minus size={13} /></button>
                            <button onClick={() => handleUpdateQuantity(it.id, it.quantity + 1)} className="btn btn-outline btn-sm btn-icon" title="Aumentar"><Plus size={13} /></button>
                            <button onClick={() => handleDeleteItem(it.id)} className="btn btn-danger-soft btn-sm btn-icon" title="Remover"><Trash2 size={13} /></button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="card card-pad" style={{ boxShadow: 'none', background: 'var(--bg-subtle)', display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <div className="summary-row"><span>Consumo</span><span className="money">R$ {subtotalAmount.toFixed(2)}</span></div>
              <div className="summary-row">
                <span>{taxLabel}</span>
                <span className="money">{tipAmount > 0 ? `+ R$ ${tipAmount.toFixed(2)}` : 'Não incluída'}</span>
              </div>
              <div className="summary-total">
                <span className="label-total">Total a receber</span>
                <span className="value-total">R$ {finalTotalAmount.toFixed(2)}</span>
              </div>
              {trocoExibido > 0 && (
                <div className="summary-row" style={{ color: 'var(--amber)', fontWeight: 600, paddingTop: '6px' }}>
                  <span>Troco a devolver</span>
                  <span className="money">R$ {trocoExibido.toFixed(2)}</span>
                </div>
              )}
            </div>

            <div className="modal-actions">
              <button onClick={() => setShowVerifyModal(false)} className="btn btn-outline"><Pencil size={15} /> Voltar e corrigir</button>
              <button onClick={handleFinalProcessPayment} disabled={loading} className="btn btn-success" style={{ flex: 2 }}>
                <CheckCircle2 size={17} />
                {loading ? 'Fechando...' : `Confirmar R$ ${finalTotalAmount.toFixed(2)}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Cupom */}
      {receiptText && (
        <div className="modal-overlay">
          <div className="modal animate-fade-in">
            <div className="modal-head">
              <h2 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Printer size={18} color="var(--text-secondary)" /> Cupom da mesa
              </h2>
              <button onClick={() => setReceiptText(null)} className="btn-close"><X size={19} /></button>
            </div>
            <p className="hint">Uma cópia foi salva na pasta comprovantes_mesas na Área de Trabalho.</p>
            <pre className="receipt-preview">{receiptText}</pre>
            <div className="modal-actions">
              <button onClick={() => setReceiptText(null)} className="btn btn-outline">Fechar</button>
              <button onClick={() => printReceiptContent(receiptText, 'Cupom da Mesa')} className="btn btn-primary"><Printer size={16} /> Imprimir</button>
            </div>
          </div>
        </div>
      )}

      <div className="page-head">
        <div>
          <h1 className="page-title">Caixa</h1>
          <div className="page-subtitle">Escolha uma mesa para conferir o consumo e receber o pagamento.</div>
        </div>
        <button onClick={loadTables} className="btn btn-outline btn-sm"><RefreshCw size={15} /> Atualizar mesas</button>
      </div>

      <div className="split-layout split-layout-wide">
        <div className="card card-pad">
          <div className="card-head">
            <h2>Mesas</h2>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              <span className="badge badge-free">Livre</span>
              <span className="badge badge-occupied">Consumindo</span>
              <span className="badge badge-pending">Aguardando</span>
            </div>
          </div>
          <div className="scroll-area scroll-table" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(104px, 1fr))', gap: '10px', alignContent: 'start' }}>
            {tables.map(t => (
              <button key={t.id} onClick={() => handleSelectTable(t)} className={`pick ${selectedTable?.id === t.id ? 'is-active' : ''}`}>
                <span className="pick-title">Mesa {t.number}</span>
                <span className={`badge ${t.status === 'FREE' ? 'badge-free' : t.status === 'OCCUPIED' ? 'badge-occupied' : 'badge-pending'}`}>
                  {t.status === 'FREE' ? 'Livre' : t.status === 'OCCUPIED' ? 'Consumindo' : 'Aguardando'}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="card card-pad" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div className="card-head" style={{ marginBottom: 0 }}>
            <div>
              <h2 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Receipt size={18} color="var(--text-secondary)" /> Conta da mesa
              </h2>
              <div className="hint">{selectedTable ? selectedTable.name : 'Nenhuma mesa selecionada'}</div>
            </div>
            {selectedTable && bill && (
              <div className="segmented" style={{ width: 'auto' }}>
                <button onClick={() => setViewMode('ITEMS')} className={viewMode === 'ITEMS' ? 'is-active' : ''} style={{ padding: '0 10px' }}>Itens</button>
                <button onClick={() => setViewMode('TIMELINE')} className={viewMode === 'TIMELINE' ? 'is-active' : ''} style={{ padding: '0 10px' }}>Horários</button>
              </div>
            )}
          </div>

          {feedback && (
            <div className={`alert ${feedback.type === 'success' ? 'alert-success' : 'alert-error'}`}>
              {feedback.type === 'success' ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
              {feedback.message}
            </div>
          )}

          {!selectedTable || !bill ? (
            <div className="empty-state">Selecione uma mesa para ver a conta.</div>
          ) : (
            <>
              <button onClick={() => handlePrintPreBill(selectedTable.id)} className="btn btn-outline btn-block">
                <Printer size={16} /> Imprimir pré-conta
              </button>

              <div className="scroll-area" style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '200px' }}>
                {viewMode === 'ITEMS'
                  ? bill.items_summary?.map((item: any) => (
                      <div key={item.menu_item_id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', padding: '9px 11px', background: 'var(--bg-subtle)', borderRadius: 'var(--radius-md)', fontSize: '0.85rem' }}>
                        <div>
                          <div style={{ fontWeight: 600 }}>{item.quantity}x {item.name}</div>
                          <div className="hint">R$ {item.unit_price.toFixed(2)} cada</div>
                        </div>
                        <span className="money">R$ {item.total_price.toFixed(2)}</span>
                      </div>
                    ))
                  : bill.orders?.map((ord: any, idx: number) => (
                      <div key={ord.id} style={{ background: 'var(--bg-subtle)', padding: '9px 11px', borderRadius: 'var(--radius-md)', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', fontSize: '0.78rem', fontWeight: 600, paddingBottom: '4px', borderBottom: '1px solid var(--border)' }}>
                          <span>Pedido {idx + 1} — {new Date(ord.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span>
                          <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>{ord.waiter_name || 'Equipe'}</span>
                        </div>
                        {ord.items?.map((it: any) => (
                          <div key={it.id} style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', fontSize: '0.82rem' }}>
                            <span>{it.quantity}x {it.menu_item_name}</span>
                            <span className="money">R$ {it.total_price.toFixed(2)}</span>
                          </div>
                        ))}
                      </div>
                    ))}
              </div>

              {taxEnabled ? (
                <label className="card card-pad" style={{ boxShadow: 'none', background: 'var(--bg-subtle)', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                  <span className="checkbox-row" style={{ margin: 0 }}>
                    <input type="checkbox" checked={includeTip} onChange={e => handleToggleTip(e.target.checked)} />
                    Cobrar {taxLabel.toLowerCase()}
                  </span>
                  <span className="money" style={{ color: includeTip ? 'var(--green)' : 'var(--text-muted)' }}>+ R$ {potentialTip.toFixed(2)}</span>
                </label>
              ) : (
                <div className="alert alert-info">
                  <AlertCircle size={16} /> Taxa de serviço desativada em Gestão &gt; Configurações.
                </div>
              )}

              <div className="card card-pad" style={{ boxShadow: 'none', background: 'var(--brand-soft)', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <div className="summary-row"><span>Consumo</span><span className="money">R$ {subtotalAmount.toFixed(2)}</span></div>
                <div className="summary-row">
                  <span>{taxLabel}</span>
                  <span className="money">{tipAmount > 0 ? `+ R$ ${tipAmount.toFixed(2)}` : 'R$ 0.00'}</span>
                </div>
                <div className="summary-total">
                  <span className="label-total">Total a pagar</span>
                  <span className="value-total">R$ {finalTotalAmount.toFixed(2)}</span>
                </div>
              </div>

              {allowedMethods.length > 1 && (
                <div className="segmented">
                  <button onClick={() => setIsSplitMode(false)} className={!isSplitMode ? 'is-active' : ''}>Uma forma</button>
                  <button
                    onClick={() => {
                      setIsSplitMode(true);
                      if (splitRows.length === 0) setSplitRows([{ id: '1', method: allowedMethods[0]!, amount: finalTotalAmount }]);
                    }}
                    className={isSplitMode ? 'is-active' : ''}
                  >
                    <Layers size={14} /> Dividir
                  </button>
                </div>
              )}

              {!isSplitMode ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  <span className="label">Forma de pagamento</span>
                  <div style={{ display: 'grid', gridTemplateColumns: allowedMethods.length > 1 ? 'repeat(auto-fit, minmax(150px, 1fr))' : '1fr', gap: '8px' }}>
                    {allowedMethods.map(m => (
                      <button
                        key={m}
                        onClick={() => {
                          setSingleMethod(m);
                          if (m === 'CASH' && (!singleAmountPaid || parseFloat(singleAmountPaid) === 0)) {
                            setSingleAmountPaid(finalTotalAmount.toString());
                          }
                        }}
                        className={`method-pick ${singleMethod === m ? 'is-active' : ''}`}
                      >
                        {METHOD_ICONS[m]} {METHOD_LABELS[m]}
                      </button>
                    ))}
                  </div>

                  {singleMethod === 'CASH' && (
                    <div className="card card-pad" style={{ boxShadow: 'none', background: 'var(--amber-soft)', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      <label className="label">Valor entregue pelo cliente (R$)</label>
                      <input type="number" step="0.01" inputMode="decimal" value={singleAmountPaid} onChange={e => setSingleAmountPaid(e.target.value)} className="input" />
                      <div className="summary-row" style={{ color: 'var(--amber)', fontWeight: 600 }}>
                        <span>Troco</span>
                        <span className="money">R$ {singleChange.toFixed(2)}</span>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
                    <span className="label">Formas de pagamento</span>
                    <button onClick={handleAddSplitRow} className="btn btn-outline btn-sm"><Plus size={14} /> Adicionar</button>
                  </div>

                  <div className="scroll-area" style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '260px' }}>
                    {splitRows.map((row, idx) => (
                      <div key={row.id} style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                        <span className="hint" style={{ minWidth: '16px' }}>{idx + 1}.</span>
                        <select
                          value={row.method}
                          onChange={e => handleUpdateSplitRow(row.id, 'method', e.target.value as PaymentMethodType)}
                          className="input"
                          style={{ flex: 1, minWidth: 0 }}
                        >
                          {allowedMethods.map(m => <option key={m} value={m}>{METHOD_LABELS[m]}</option>)}
                        </select>
                        <input
                          type="number"
                          step="0.01"
                          inputMode="decimal"
                          value={row.amount}
                          onChange={e => handleUpdateSplitRow(row.id, 'amount', money(parseFloat(e.target.value) || 0))}
                          className="input"
                          style={{ width: '104px', flexShrink: 0 }}
                        />
                        {splitRows.length > 1 && (
                          <button onClick={() => handleRemoveSplitRow(row.id)} className="btn btn-danger-soft btn-sm btn-icon" title="Remover"><Trash2 size={14} /></button>
                        )}
                      </div>
                    ))}
                  </div>

                  <p className="hint">
                    Na linha de dinheiro, informe o valor que o cliente entregou. O troco é calculado sozinho.
                  </p>

                  <div style={{ background: 'var(--bg-subtle)', padding: '10px 12px', borderRadius: 'var(--radius-md)', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <div className="summary-row"><span>Informado</span><span className="money">R$ {totalAllocated.toFixed(2)}</span></div>
                    <div className="summary-row">
                      <span>Falta</span>
                      <span className="money" style={{ color: remainingToAllocate > 0 ? 'var(--red)' : 'var(--green)' }}>
                        R$ {remainingToAllocate.toFixed(2)}
                      </span>
                    </div>
                    {totalSplitChange > 0 && (
                      <div className="summary-row" style={{ fontWeight: 700, color: 'var(--amber)', borderTop: '1px solid var(--border)', paddingTop: '6px', marginTop: '2px' }}>
                        <span>Troco a devolver</span>
                        <span className="money">R$ {totalSplitChange.toFixed(2)}</span>
                      </div>
                    )}
                  </div>

                  {excedenteEletronico > 0.009 && (
                    <div className="alert alert-warning" style={{ flexDirection: 'column', alignItems: 'stretch', gap: '10px' }}>
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
                        <AlertCircle size={17} style={{ flexShrink: 0, marginTop: '2px' }} />
                        <span>
                          Há <strong>R$ {excedenteEletronico.toFixed(2)}</strong> a mais em PIX ou cartão.
                          Não existe troco nessas formas — cobre o valor exato ou registre a diferença em dinheiro.
                        </span>
                      </div>
                      <button onClick={ajustarExcedente} className="btn btn-outline btn-sm">
                        <Wand2 size={14} /> Ajustar automaticamente
                      </button>
                    </div>
                  )}
                </div>
              )}

              <button
                onClick={() => setShowVerifyModal(true)}
                disabled={loading || (isSplitMode && !podeFechar)}
                className="btn btn-success btn-block btn-lg"
              >
                <ShieldCheck size={17} />
                {loading
                  ? 'Processando...'
                  : isSplitMode
                    ? (remainingToAllocate > 0.009
                        ? `Faltam R$ ${remainingToAllocate.toFixed(2)}`
                        : excedenteEletronico > 0.009
                          ? `Corrija R$ ${excedenteEletronico.toFixed(2)} em PIX/cartão`
                          : 'Conferir e fechar mesa')
                    : `Conferir e fechar (${METHOD_LABELS[singleMethod]})`}
              </button>
            </>
          )}
        </div>
      </div>

      {closedHistory.length > 0 && (
        <div className="card card-pad">
          <div className="card-head"><h2>Contas fechadas hoje</h2></div>
          <div className="scroll-area" style={{ display: 'flex', flexDirection: 'column', gap: '10px', maxHeight: '360px' }}>
            {closedHistory.map((detail, idx) => (
              <div key={idx} style={{ padding: '12px', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
                <div>
                  <span style={{ fontWeight: 600 }}>Mesa {detail.table_number}</span>
                  <span className="hint" style={{ marginLeft: '10px' }}>{detail.waiter_name} • {formatDateTimeBR(detail.closed_at)}</span>
                  <div className="hint">Total: R$ {detail.total_amount.toFixed(2)}</div>
                </div>
                <button onClick={() => handleReprintReceipt(detail.order_id)} className="btn btn-outline btn-sm">
                  <Printer size={14} /> Reimprimir cupom
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
