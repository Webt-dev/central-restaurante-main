import React, { useState, useEffect } from 'react';
import QRCode from 'qrcode';
import type { DailyReport, InventoryItem, SystemInfo, ConnectedDevice } from '../types';
import { api } from '../services/api';
import { socket } from '../services/socket';
import { formatDateBR, formatDateTimeBR } from '../utils/dateUtils';
import { printReceiptContent } from '../utils/printUtils';
import { useServiceTaxPercent, formatPercent } from '../services/settings';
import { formatQuantity, cleanInventoryName, getStockHealth } from '../utils/units';
import {
  TrendingUp, Package, AlertTriangle, Calendar, ShoppingBag, Percent, Award,
  RefreshCw, Printer, X, ShieldAlert, CheckCircle2, Lock, FileText,
  Smartphone, Monitor, Tv, Wifi, Copy, Check, Utensils, Wine, Trophy, CreditCard, Flame
} from 'lucide-react';

export const ReportsStockScreen: React.FC = () => {
  const taxPercent = useServiceTaxPercent();
  const taxLabel = `Taxa de serviço (${formatPercent(taxPercent)}%)`;

  const [report, setReport] = useState<DailyReport | null>(null);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [receiptText, setReceiptText] = useState<string | null>(null);

  const [showCloseConfirmModal, setShowCloseConfirmModal] = useState<boolean>(false);
  const [expedientResult, setExpedientResult] = useState<any | null>(null);
  const [closingExpedient, setClosingExpedient] = useState<boolean>(false);
  const [reportTxtModal, setReportTxtModal] = useState<string | null>(null);

  const [showDeviceModal, setShowDeviceModal] = useState<boolean>(false);
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState<string | null>(null);
  const [connectedDevices, setConnectedDevices] = useState<ConnectedDevice[]>([]);
  const [copiedUrl, setCopiedUrl] = useState<boolean>(false);

  useEffect(() => {
    loadData();
    loadSystemInfo();
    if (socket) {
      socket.on('payment:processed', loadData);
      socket.on('order:created', loadData);
      socket.on('inventory:updated', loadData);
      socket.on('devices:updated', (devices: ConnectedDevice[]) => setConnectedDevices(devices));
    }
    return () => {
      if (socket) {
        socket.off('payment:processed');
        socket.off('order:created');
        socket.off('inventory:updated');
        socket.off('devices:updated');
      }
    };
  }, []);

  async function loadData() {
    setRefreshing(true);
    try {
      const [rData, iData] = await Promise.all([api.getDailyReport(), api.getInventory()]);
      setReport(rData);
      setInventory(iData);
    } catch (err) {
      console.error('Erro ao carregar relatórios e estoque:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  async function loadSystemInfo() {
    try {
      const sys = await api.getSystemInfo();
      setSystemInfo(sys);
      setConnectedDevices(sys.connected_devices || []);
      const frontendTargetUrl = sys.frontend_url || `http://${window.location.hostname}:3000`;
      QRCode.toDataURL(frontendTargetUrl, { width: 260, margin: 2, color: { dark: '#1B2430', light: '#FFFFFF' } }, (err, url) => {
        if (!err && url) setQrCodeDataUrl(url);
      });
    } catch (err) {
      console.error('Erro ao obter informações do sistema:', err);
    }
  }

  function handleOpenDeviceModal() {
    loadSystemInfo();
    setShowDeviceModal(true);
  }

  function handleCopyFrontendUrl() {
    if (systemInfo?.frontend_url) {
      navigator.clipboard.writeText(systemInfo.frontend_url);
      setCopiedUrl(true);
      setTimeout(() => setCopiedUrl(false), 2000);
    }
  }

  async function handleReprintReceipt(orderId: string) {
    try {
      const res = await api.reprintReceipt(orderId);
      if (res.receipt_text) setReceiptText(res.receipt_text);
    } catch (err: any) {
      alert(`Não foi possível carregar o cupom: ${err.message}`);
    }
  }

  async function handleFinalCloseExpedient() {
    setClosingExpedient(true);
    try {
      const res = await api.closeDailyExpedient();
      setExpedientResult(res);
      setShowCloseConfirmModal(false);
      loadData();
    } catch (err: any) {
      alert(`Não foi possível encerrar o expediente: ${err.message}`);
    } finally {
      setClosingExpedient(false);
    }
  }

  if (loading) {
    return <div className="empty-state">Carregando dados financeiros e de estoque...</div>;
  }

  const lowStockCount = inventory.filter(i => i.quantity <= i.min_quantity).length;
  const frontendUrlDisplay = systemInfo?.frontend_url || `http://${window.location.hostname}:3000`;

  // Ordena o estoque pelos itens mais críticos primeiro.
  const sortedInventory = [...inventory].sort((a, b) => {
    const ra = a.min_quantity > 0 ? a.quantity / a.min_quantity : 999;
    const rb = b.min_quantity > 0 ? b.quantity / b.min_quantity : 999;
    return ra - rb;
  });

  return (
    <div className="page">
      {/* Dispositivos */}
      {showDeviceModal && (
        <div className="modal-overlay">
          <div className="modal modal-lg animate-fade-in">
            <div className="modal-head">
              <div>
                <h2>Conectar um celular ou tablet</h2>
                <div className="hint">Aponte a câmera para o código ou digite o endereço no navegador.</div>
              </div>
              <button onClick={() => setShowDeviceModal(false)} className="btn-close"><X size={19} /></button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: '16px', alignItems: 'center' }}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', background: '#FFFFFF', padding: '14px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)' }}>
                {qrCodeDataUrl ? (
                  <img src={qrCodeDataUrl} alt="Código de conexão" style={{ width: '190px', height: '190px' }} />
                ) : (
                  <div style={{ width: '190px', height: '190px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}>Gerando código...</div>
                )}
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <h3>Passo a passo</h3>
                <ol style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', paddingLeft: '18px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <li>Conecte o celular no mesmo Wi-Fi do computador.</li>
                  <li>Abra a câmera e aponte para o código ao lado.</li>
                  <li>Ou digite este endereço no navegador do celular:</li>
                </ol>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'var(--bg-subtle)', padding: '9px 12px', borderRadius: 'var(--radius-md)' }}>
                  <code style={{ fontSize: '0.85rem', fontWeight: 600, flex: 1, wordBreak: 'break-all' }}>{frontendUrlDisplay}</code>
                  <button onClick={handleCopyFrontendUrl} className="btn btn-outline btn-sm">
                    {copiedUrl ? <Check size={14} /> : <Copy size={14} />}
                    {copiedUrl ? 'Copiado' : 'Copiar'}
                  </button>
                </div>
              </div>
            </div>

            <div>
              <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
                <Wifi size={16} color="var(--text-secondary)" /> Aparelhos conectados ({connectedDevices.length})
              </h3>

              {connectedDevices.length === 0 ? (
                <div className="empty-state" style={{ padding: '20px' }}>Nenhum aparelho conectado no momento.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '200px', overflowY: 'auto' }}>
                  {connectedDevices.map(dev => (
                    <div key={dev.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--bg-subtle)', padding: '10px 12px', borderRadius: 'var(--radius-md)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        {dev.deviceType.includes('iPhone') || dev.deviceType.includes('Smartphone') || dev.deviceType.includes('Tablet')
                          ? <Smartphone size={18} color="var(--text-secondary)" />
                          : dev.deviceType.includes('TV')
                            ? <Tv size={18} color="var(--text-secondary)" />
                            : <Monitor size={18} color="var(--text-secondary)" />}
                        <div>
                          <div style={{ fontWeight: 600, fontSize: '0.86rem' }}>{dev.deviceType}</div>
                          <div className="hint">IP {dev.ip} • {dev.room}</div>
                        </div>
                      </div>
                      <span className="badge badge-free">Online</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <button onClick={() => setShowDeviceModal(false)} className="btn btn-outline btn-block">Fechar</button>
          </div>
        </div>
      )}

      {/* Confirmar encerramento */}
      {showCloseConfirmModal && (
        <div className="modal-overlay">
          <div className="modal animate-fade-in">
            <div className="modal-head">
              <h2 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <ShieldAlert size={19} color="var(--red)" /> Encerrar o expediente
              </h2>
              <button onClick={() => setShowCloseConfirmModal(false)} className="btn-close"><X size={19} /></button>
            </div>

            <div className="alert alert-warning" style={{ alignItems: 'flex-start', flexDirection: 'column', gap: '8px' }}>
              <strong>Deseja encerrar o dia {formatDateBR(report?.date)}?</strong>
              <ul style={{ paddingLeft: '18px', fontSize: '0.84rem', fontWeight: 400 }}>
                <li>O faturamento do dia será consolidado e zerado para amanhã.</li>
                <li>Os insumos usados serão descontados do estoque.</li>
                <li>Um relatório em .TXT será salvo na Área de Trabalho.</li>
              </ul>
            </div>

            <div className="modal-actions">
              <button onClick={() => setShowCloseConfirmModal(false)} className="btn btn-outline">Voltar</button>
              <button onClick={handleFinalCloseExpedient} disabled={closingExpedient} className="btn btn-danger" style={{ flex: 2 }}>
                <Lock size={16} /> {closingExpedient ? 'Encerrando...' : 'Encerrar expediente'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Resultado do fechamento */}
      {expedientResult && (
        <div className="modal-overlay">
          <div className="modal modal-xl animate-fade-in">
            <div className="modal-head">
              <div>
                <h2 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <CheckCircle2 size={19} color="var(--green)" /> Expediente encerrado
                </h2>
                <div className="hint">{formatDateTimeBR(expedientResult.closed_at)}</div>
              </div>
              <button onClick={() => setExpedientResult(null)} className="btn-close"><X size={19} /></button>
            </div>

            {expedientResult.report_text && (
              <div className="alert alert-success" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
                <span>Relatório salvo na pasta relatorios_expediente.</span>
                <button onClick={() => setReportTxtModal(expedientResult.report_text)} className="btn btn-outline btn-sm">
                  <FileText size={14} /> Ver relatório
                </button>
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '12px' }}>
              <div className="card card-pad" style={{ boxShadow: 'none' }}>
                <div className="stat-label">Faturamento total</div>
                <div className="stat-value">R$ {expedientResult.report.total_sales?.toFixed(2) || '0.00'}</div>
              </div>
              <div className="card card-pad" style={{ boxShadow: 'none' }}>
                <div className="stat-label">Consumo (sem taxa)</div>
                <div className="stat-value">R$ {expedientResult.report.total_sales_subtotal?.toFixed(2) || '0.00'}</div>
              </div>
              <div className="card card-pad" style={{ boxShadow: 'none' }}>
                <div className="stat-label">{taxLabel}</div>
                <div className="stat-value">R$ {expedientResult.report.total_sales_tips?.toFixed(2) || '0.00'}</div>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '10px' }}>
              <div className="card card-pad" style={{ boxShadow: 'none' }}>
                <div className="stat-label" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}><Utensils size={14} /> Prato mais vendido</div>
                <div style={{ fontWeight: 600, marginTop: '4px' }}>{expedientResult.analytics.top_food.name}</div>
                <div className="hint">{expedientResult.analytics.top_food.total_qty} un — R$ {expedientResult.analytics.top_food.total_revenue.toFixed(2)}</div>
              </div>
              <div className="card card-pad" style={{ boxShadow: 'none' }}>
                <div className="stat-label" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}><Wine size={14} /> Bebida mais vendida</div>
                <div style={{ fontWeight: 600, marginTop: '4px' }}>{expedientResult.analytics.top_drink.name}</div>
                <div className="hint">{expedientResult.analytics.top_drink.total_qty} un — R$ {expedientResult.analytics.top_drink.total_revenue.toFixed(2)}</div>
              </div>
              <div className="card card-pad" style={{ boxShadow: 'none' }}>
                <div className="stat-label" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}><Trophy size={14} /> Mesa que mais faturou</div>
                <div style={{ fontWeight: 600, marginTop: '4px' }}>
                  {expedientResult.analytics.top_table.table_number ? `Mesa ${expedientResult.analytics.top_table.table_number}` : 'Sem dados'}
                </div>
                <div className="hint">R$ {expedientResult.analytics.top_table.total_revenue.toFixed(2)}</div>
              </div>
              <div className="card card-pad" style={{ boxShadow: 'none' }}>
                <div className="stat-label" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}><CreditCard size={14} /> Pagamento mais usado</div>
                <div style={{ fontWeight: 600, marginTop: '4px' }}>{expedientResult.analytics.top_payment.payment_method}</div>
                <div className="hint">R$ {expedientResult.analytics.top_payment.total_revenue.toFixed(2)}</div>
              </div>
            </div>

            <div>
              <h3 style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px' }}>
                <Flame size={15} color="var(--text-secondary)" /> Insumos descontados do estoque
              </h3>
              {expedientResult.inventory_consumed.length === 0 ? (
                <div className="empty-state" style={{ padding: '16px' }}>Nenhum insumo consumido hoje.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '200px', overflowY: 'auto' }}>
                  {expedientResult.inventory_consumed.map((inv: any) => (
                    <div key={inv.id} style={{ display: 'flex', justifyContent: 'space-between', background: 'var(--bg-subtle)', padding: '9px 12px', borderRadius: 'var(--radius-sm)', fontSize: '0.85rem' }}>
                      <span style={{ fontWeight: 600 }}>{cleanInventoryName(inv.name)}</span>
                      <span className="money" style={{ color: 'var(--red)' }}>- {formatQuantity(inv.total_consumed, inv.unit)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <button onClick={() => setExpedientResult(null)} className="btn btn-primary btn-block">Concluir</button>
          </div>
        </div>
      )}

      {/* Documento .TXT */}
      {reportTxtModal && (
        <div className="modal-overlay">
          <div className="modal modal-lg animate-fade-in">
            <div className="modal-head">
              <h2 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <FileText size={18} color="var(--text-secondary)" /> Relatório do expediente
              </h2>
              <button onClick={() => setReportTxtModal(null)} className="btn-close"><X size={19} /></button>
            </div>
            <pre className="receipt-preview" style={{ maxHeight: '400px' }}>{reportTxtModal}</pre>
            <div className="modal-actions">
              <button onClick={() => setReportTxtModal(null)} className="btn btn-outline">Fechar</button>
              <button onClick={() => printReceiptContent(reportTxtModal, 'Relatório do Expediente')} className="btn btn-primary">
                <Printer size={16} /> Imprimir
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
                <Printer size={18} color="var(--text-secondary)" /> Cupom
              </h2>
              <button onClick={() => setReceiptText(null)} className="btn-close"><X size={19} /></button>
            </div>
            <pre className="receipt-preview">{receiptText}</pre>
            <div className="modal-actions">
              <button onClick={() => setReceiptText(null)} className="btn btn-outline">Fechar</button>
              <button onClick={() => printReceiptContent(receiptText, 'Cupom')} className="btn btn-primary"><Printer size={16} /> Imprimir</button>
            </div>
          </div>
        </div>
      )}

      {/* Painel do dia */}
      <div className="page-head">
        <div>
          <h1 className="page-title">Relatórios e estoque</h1>
          <div className="page-subtitle" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Calendar size={14} /> {formatDateBR(report?.date)}
          </div>
        </div>
        <div className="toolbar">
          <button onClick={handleOpenDeviceModal} className="btn btn-outline btn-sm"><Smartphone size={15} /> Conectar aparelho</button>
          <button onClick={loadData} className="btn btn-outline btn-sm"><RefreshCw size={15} className={refreshing ? 'spin' : ''} /> Atualizar</button>
          <button onClick={() => setShowCloseConfirmModal(true)} className="btn btn-danger btn-sm"><Lock size={15} /> Encerrar expediente</button>
        </div>
      </div>

      <div className="grid-auto">
        <div className="card stat">
          <span className="stat-icon"><TrendingUp size={19} /></span>
          <div>
            <div className="stat-label">Faturamento total</div>
            <div className="stat-value">R$ {report?.total_sales.toFixed(2) || '0.00'}</div>
          </div>
        </div>
        <div className="card stat">
          <span className="stat-icon"><ShoppingBag size={19} /></span>
          <div>
            <div className="stat-label">Consumo (sem taxa)</div>
            <div className="stat-value">R$ {report?.total_sales_subtotal?.toFixed(2) || '0.00'}</div>
          </div>
        </div>
        <div className="card stat">
          <span className="stat-icon"><Percent size={19} /></span>
          <div>
            <div className="stat-label">{taxLabel}</div>
            <div className="stat-value">R$ {report?.total_sales_tips?.toFixed(2) || '0.00'}</div>
          </div>
        </div>
        <div className="card stat">
          <span className="stat-icon"><Award size={19} /></span>
          <div>
            <div className="stat-label">Contas fechadas</div>
            <div className="stat-value">{report?.total_orders_closed || 0}</div>
          </div>
        </div>
        <div className="card stat">
          <span className="stat-icon"><Package size={19} /></span>
          <div>
            <div className="stat-label">Insumos para repor</div>
            <div className="stat-value" style={{ color: lowStockCount > 0 ? 'var(--red)' : 'var(--text-primary)' }}>{lowStockCount}</div>
          </div>
        </div>
      </div>

      <div className="responsive-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '18px', alignItems: 'start' }}>
        <div className="card card-pad">
          <div className="card-head"><h2>Vendas por forma de pagamento</h2></div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {[
              { label: 'PIX', value: report?.by_payment_method.PIX },
              { label: 'Cartão de crédito', value: report?.by_payment_method.CREDIT_CARD },
              { label: 'Cartão de débito', value: report?.by_payment_method.DEBIT_CARD },
              { label: 'Dinheiro', value: report?.by_payment_method.CASH }
            ].map(row => (
              <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 12px', background: 'var(--bg-subtle)', borderRadius: 'var(--radius-md)', fontSize: '0.87rem' }}>
                <span>{row.label}</span>
                <span className="money">R$ {(row.value || 0).toFixed(2)}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="card card-pad">
          <div className="card-head">
            <div>
              <h2>Estoque de insumos</h2>
              <div className="hint">Os mais críticos aparecem primeiro. A barra enche em 10x o mínimo.</div>
            </div>
            {lowStockCount > 0 && (
              <span className="badge badge-occupied"><AlertTriangle size={12} /> {lowStockCount} para repor</span>
            )}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', maxHeight: '320px', overflowY: 'auto' }}>
            {sortedInventory.map(item => {
              const health = getStockHealth(item.quantity, item.min_quantity);
              return (
                <div key={item.id} style={{ display: 'flex', flexDirection: 'column', gap: '6px', padding: '10px 11px', background: 'var(--bg-subtle)', borderRadius: 'var(--radius-md)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '8px', fontSize: '0.84rem' }}>
                    <span style={{ fontWeight: 600 }}>{cleanInventoryName(item.name)}</span>
                    <span className="money" style={{ color: health.color }}>{formatQuantity(item.quantity, item.unit)}</span>
                  </div>

                  <div className="meter">
                    <div className="meter-fill" style={{ width: `${health.percent}%`, background: health.color }} />
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.72rem' }}>
                    <span style={{ color: health.color, fontWeight: 600 }}>{health.label}</span>
                    <span className="hint">mínimo {formatQuantity(item.min_quantity, item.unit)}</span>
                  </div>
                </div>
              );
            })}
            {inventory.length === 0 && <div className="empty-state">Nenhum insumo cadastrado.</div>}
          </div>
        </div>
      </div>

      <div className="card card-pad">
        <div className="card-head"><h2>Contas fechadas por mesa</h2></div>
        {!report?.table_orders_detail || report.table_orders_detail.length === 0 ? (
          <div className="empty-state">Nenhuma conta foi fechada nesta data.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {report.table_orders_detail.map((detail, idx) => (
              <div key={idx} style={{ padding: '12px', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
                  <div>
                    <span style={{ fontWeight: 600 }}>Mesa {detail.table_number}</span>
                    <span className="hint" style={{ marginLeft: '10px' }}>{detail.waiter_name} • {formatDateTimeBR(detail.closed_at)}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <span className="money" style={{ fontSize: '1rem' }}>R$ {detail.total_amount.toFixed(2)}</span>
                    <button onClick={() => handleReprintReceipt(detail.order_id)} className="btn btn-outline btn-sm">
                      <Printer size={14} /> Reimprimir
                    </button>
                  </div>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                  {detail.items.map((i, iIdx) => (
                    <span key={iIdx} className="badge badge-neutral">
                      {i.quantity}x {i.name} — R$ {i.total_price.toFixed(2)}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
