import React, { useState, useEffect } from 'react';
import type { Table, MenuItem, InventoryItem, RestaurantSettings, ThemePreference } from '../types';
import { UsersPanel } from './UsersPanel';
import { SupervisorPinSettings } from './SupervisorPinSettings';
import { FiscalModulePanel } from './FiscalModulePanel';
import { LicensePanel } from './LicensePanel';
import { useSearchParams } from 'react-router-dom';
import { MenuFiscalFields, type MenuFiscalValues } from './MenuFiscalFields';
import { api } from '../services/api';
import { socket } from '../services/socket';
import { loadSettings, normalizePercent, formatPercent } from '../services/settings';
import { formatQuantity, cleanInventoryName, getStockHealth, UNIT_OPTIONS, unitLabel } from '../utils/units';
import {
  Utensils, Package, Settings, Plus, Trash2, Pencil, Save, X, CheckCircle2,
  AlertTriangle, Grid, CreditCard, Building2, RefreshCw, Search,
  KeyRound, Percent, Users, Palette, Sun, Moon, Monitor, Blocks, ShieldCheck
} from 'lucide-react';

type AdminTab = 'tables' | 'menu' | 'inventory' | 'users' | 'modules' | 'license' | 'settings';

const THEME_OPTIONS: { key: ThemePreference; label: string; hint: string; Icon: typeof Sun }[] = [
  { key: 'light', label: 'Claro', hint: 'Fundo claro em todos os aparelhos', Icon: Sun },
  { key: 'dark', label: 'Escuro', hint: 'Fundo escuro em todos os aparelhos', Icon: Moon },
  { key: 'system', label: 'Usar cores do sistema', hint: 'Cada aparelho segue o tema do próprio celular ou computador', Icon: Monitor }
];

const PAYMENT_OPTIONS = [
  { key: 'PIX', label: 'PIX', hint: 'QR Code e chave Pix' },
  { key: 'CREDIT_CARD', label: 'Cartão de crédito', hint: 'Maquininha de crédito' },
  { key: 'DEBIT_CARD', label: 'Cartão de débito', hint: 'Maquininha de débito' }
];

export const AdminScreen: React.FC = () => {
  const [credForm, setCredForm] = useState({ currentPassword: '', newUsername: '', newPassword: '', confirmPassword: '' });

  // ?aba=licenca abre direto na licença (link da faixa de aviso).
  const [searchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState<AdminTab>(searchParams.get('aba') === 'licenca' ? 'license' : 'tables');
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [tables, setTables] = useState<Table[]>([]);
  const [menuItems, setMenuItems] = useState<MenuItem[]>([]);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [settings, setSettings] = useState<RestaurantSettings>({
    restaurant_name: 'Central Restaurante',
    cnpj: '',
    phone: '',
    address: '',
    service_tax_percent: 10,
    payment_methods_allowed: ['CASH', 'CREDIT_CARD', 'DEBIT_CARD', 'PIX'],
    theme: 'system'
  });
  const [taxInput, setTaxInput] = useState<string>('10');
  const [savingSettings, setSavingSettings] = useState<boolean>(false);

  const [newTableNum, setNewTableNum] = useState<string>('');
  const [newTableName, setNewTableName] = useState<string>('');
  const [editingTable, setEditingTable] = useState<Table | null>(null);
  const [editTableNum, setEditTableNum] = useState<string>('');
  const [editTableName, setEditTableName] = useState<string>('');

  const [menuSearch, setMenuSearch] = useState('');
  const [menuCategoryFilter, setMenuCategoryFilter] = useState('ALL');
  const [showAddMenuModal, setShowAddMenuModal] = useState(false);
  const [newMenuForm, setNewMenuForm] = useState({ name: '', description: '', price: '', category: 'Pratos Principais' });
  const [newMenuFiscal, setNewMenuFiscal] = useState<MenuFiscalValues>({});
  const [editingMenu, setEditingMenu] = useState<MenuItem | null>(null);

  const [invSearch, setInvSearch] = useState('');
  const [showAddInvModal, setShowAddInvModal] = useState(false);
  const [editingInv, setEditingInv] = useState<InventoryItem | null>(null);
  const [newInvForm, setNewInvForm] = useState({ name: '', unit: 'g', quantity: '', min_quantity: '', unit_price: '' });

  useEffect(() => {
    loadAllAdminData();
    if (socket) {
      socket.on('tables:updated', loadAllAdminData);
      socket.on('menu:updated', loadAllAdminData);
      socket.on('inventory:updated', loadAllAdminData);
      socket.on('settings:updated', loadAllAdminData);
    }
    return () => {
      if (socket) {
        socket.off('tables:updated', loadAllAdminData);
        socket.off('menu:updated', loadAllAdminData);
        socket.off('inventory:updated', loadAllAdminData);
        socket.off('settings:updated', loadAllAdminData);
      }
    };
  }, []);

  async function loadAllAdminData() {
    try {
      const [tList, mList, iList, sData] = await Promise.all([
        api.getTables(),
        api.getMenuItems(),
        api.getInventory(),
        api.getSettings()
      ]);
      setTables(tList);
      setMenuItems(mList);
      setInventory(iList);
      setSettings({
        ...sData,
        payment_methods_allowed: Array.isArray(sData.payment_methods_allowed) ? sData.payment_methods_allowed : ['CASH']
      });
      setTaxInput(formatPercent(normalizePercent(sData.service_tax_percent)));
    } catch (err: any) {
      showMessage('error', err.message || 'Não foi possível carregar os dados do painel.');
    }
  }

  function showMessage(type: 'success' | 'error', text: string) {
    setMessage({ type, text });
    setTimeout(() => setMessage(null), 4000);
  }

  async function handleThemeChange(theme: ThemePreference) {
    if (theme === settings.theme) return;
    try {
      const saved = await api.updateSettings({ theme });
      setSettings(prev => ({ ...prev, theme: saved.theme }));
      loadSettings(true);
      showMessage('success', 'Tema aplicado em todos os aparelhos.');
    } catch (err: any) {
      showMessage('error', err.message || 'Não foi possível alterar o tema.');
    }
  }

  async function handleChangeCredentials(e: React.FormEvent) {
    e.preventDefault();
    if (!credForm.currentPassword) return showMessage('error', 'Digite a senha atual.');
    if (credForm.newUsername && credForm.newUsername.trim().length < 3) {
      return showMessage('error', 'O novo usuário precisa ter no mínimo 3 caracteres.');
    }
    if (!credForm.newPassword || credForm.newPassword.length < 8) {
      return showMessage('error', 'A nova senha precisa ter no mínimo 8 caracteres.');
    }
    if (credForm.newPassword !== credForm.confirmPassword) {
      return showMessage('error', 'A nova senha e a confirmação não são iguais.');
    }
    try {
      await api.changeOwnCredentials({
        currentPassword: credForm.currentPassword,
        newUsername: credForm.newUsername.trim() || undefined,
        newPassword: credForm.newPassword
      });
      showMessage('success', 'Usuário e senha alterados. Guarde os novos dados de acesso.');
      setCredForm({ currentPassword: '', newUsername: '', newPassword: '', confirmPassword: '' });
    } catch (err: any) {
      showMessage('error', err.message || 'Não foi possível alterar as credenciais.');
    }
  }

  // ---------------------------------------------------------------- Mesas
  async function handleAddTable(e: React.FormEvent) {
    e.preventDefault();
    const num = parseInt(newTableNum, 10);
    if (isNaN(num) || num <= 0) return showMessage('error', 'Informe um número de mesa válido.');
    try {
      await api.addTable(num, newTableName);
      setNewTableNum('');
      setNewTableName('');
      showMessage('success', `Mesa ${num} adicionada.`);
      loadAllAdminData();
    } catch (err: any) {
      showMessage('error', err.message || 'Não foi possível adicionar a mesa.');
    }
  }

  async function handleUpdateTable(e: React.FormEvent) {
    e.preventDefault();
    if (!editingTable) return;
    const num = parseInt(editTableNum, 10);
    if (isNaN(num) || num <= 0) return showMessage('error', 'Número de mesa inválido.');
    try {
      await api.updateTable(editingTable.id, num, editTableName);
      setEditingTable(null);
      showMessage('success', 'Mesa atualizada.');
      loadAllAdminData();
    } catch (err: any) {
      showMessage('error', err.message || 'Não foi possível atualizar a mesa.');
    }
  }

  async function handleDeleteTable(table: Table) {
    if (!window.confirm(`Remover a Mesa ${table.number} (${table.name})?`)) return;
    try {
      await api.deleteTable(table.id);
      showMessage('success', `Mesa ${table.number} removida.`);
      loadAllAdminData();
    } catch (err: any) {
      showMessage('error', err.message || 'Não foi possível excluir a mesa.');
    }
  }

  // ------------------------------------------------------------- Cardápio
  /** Campos fiscais como texto (vazio = usar o padrão da configuração fiscal). */
  function fiscalPayload(v: MenuFiscalValues) {
    const keys = ['ncm', 'cfop', 'cest', 'csosn', 'cst_icms', 'cst_pis_cofins', 'origem', 'gtin'] as const;
    return Object.fromEntries(keys.map(k => [k, v[k] ?? ''])) as Record<(typeof keys)[number], string>;
  }

  async function handleAddMenuItem(e: React.FormEvent) {
    e.preventDefault();
    const price = parseFloat(newMenuForm.price.replace(',', '.'));
    if (!newMenuForm.name || isNaN(price) || price < 0) {
      return showMessage('error', 'Preencha o nome e um preço válido.');
    }
    try {
      await api.addMenuItem({
        name: newMenuForm.name,
        description: newMenuForm.description,
        price,
        category: newMenuForm.category,
        ...fiscalPayload(newMenuFiscal)
      });
      setShowAddMenuModal(false);
      setNewMenuForm({ name: '', description: '', price: '', category: 'Pratos Principais' });
      setNewMenuFiscal({});
      showMessage('success', 'Produto adicionado ao cardápio.');
      loadAllAdminData();
    } catch (err: any) {
      showMessage('error', err.message || 'Não foi possível adicionar o produto.');
    }
  }

  async function handleUpdateMenuItem(e: React.FormEvent) {
    e.preventDefault();
    if (!editingMenu) return;
    try {
      await api.updateMenuItem(editingMenu.id, {
        name: editingMenu.name,
        description: editingMenu.description,
        price: Number(editingMenu.price),
        category: editingMenu.category,
        active: editingMenu.active,
        ...fiscalPayload(editingMenu)
      });
      setEditingMenu(null);
      showMessage('success', 'Produto atualizado.');
      loadAllAdminData();
    } catch (err: any) {
      showMessage('error', err.message || 'Não foi possível atualizar o produto.');
    }
  }

  async function handleDeleteMenuItem(item: MenuItem) {
    if (!window.confirm(`Remover "${item.name}" do cardápio?`)) return;
    try {
      await api.deleteMenuItem(item.id);
      showMessage('success', 'Produto removido.');
      loadAllAdminData();
    } catch (err: any) {
      showMessage('error', err.message || 'Não foi possível excluir o produto.');
    }
  }

  // -------------------------------------------------------------- Estoque
  async function handleAddInventory(e: React.FormEvent) {
    e.preventDefault();
    const qty = parseFloat(newInvForm.quantity.replace(',', '.'));
    const min = parseFloat(newInvForm.min_quantity.replace(',', '.'));
    const cost = parseFloat(newInvForm.unit_price.replace(',', '.'));
    if (!newInvForm.name || isNaN(qty)) {
      return showMessage('error', 'Preencha o nome do insumo e a quantidade inicial.');
    }
    try {
      await api.addInventoryItem({
        name: newInvForm.name,
        unit: newInvForm.unit,
        quantity: qty,
        min_quantity: isNaN(min) ? 0 : min,
        unit_price: isNaN(cost) ? 0 : cost
      });
      setShowAddInvModal(false);
      setNewInvForm({ name: '', unit: 'g', quantity: '', min_quantity: '', unit_price: '' });
      showMessage('success', 'Insumo cadastrado.');
      loadAllAdminData();
    } catch (err: any) {
      showMessage('error', err.message || 'Não foi possível adicionar o insumo.');
    }
  }

  async function handleUpdateInventory(e: React.FormEvent) {
    e.preventDefault();
    if (!editingInv) return;
    try {
      await api.updateInventoryItem(editingInv.id, {
        name: editingInv.name,
        unit: editingInv.unit,
        quantity: Number(editingInv.quantity),
        min_quantity: Number(editingInv.min_quantity),
        unit_price: Number(editingInv.unit_price || 0)
      });
      setEditingInv(null);
      showMessage('success', 'Insumo atualizado.');
      loadAllAdminData();
    } catch (err: any) {
      showMessage('error', err.message || 'Não foi possível atualizar o insumo.');
    }
  }

  async function handleQuickRestock(item: InventoryItem, amount: number) {
    try {
      await api.restockInventoryItem(item.id, amount);
      showMessage('success', `${formatQuantity(amount, item.unit)} adicionados a ${cleanInventoryName(item.name)}.`);
      loadAllAdminData();
    } catch (err: any) {
      showMessage('error', err.message || 'Não foi possível repor o estoque.');
    }
  }

  async function handleDeleteInventory(item: InventoryItem) {
    if (!window.confirm(`Excluir o insumo "${cleanInventoryName(item.name)}"?`)) return;
    try {
      await api.deleteInventoryItem(item.id);
      showMessage('success', 'Insumo removido.');
      loadAllAdminData();
    } catch (err: any) {
      showMessage('error', err.message || 'Não foi possível remover o insumo.');
    }
  }

  function restockSteps(unit: string): { label: string; amount: number }[] {
    const u = String(unit || '').toLowerCase();
    if (u === 'g') {
      return [{ label: '+500 g', amount: 500 }, { label: '+1 kg', amount: 1000 }, { label: '+5 kg', amount: 5000 }];
    }
    if (u === 'ml') {
      return [{ label: '+500 ml', amount: 500 }, { label: '+1 L', amount: 1000 }, { label: '+5 L', amount: 5000 }];
    }
    return [{ label: '+10', amount: 10 }, { label: '+50', amount: 50 }, { label: '+100', amount: 100 }];
  }

  // -------------------------------------------------------- Configurações
  async function handleSaveSettings(e: React.FormEvent) {
    e.preventDefault();
    const parsedTax = normalizePercent(String(taxInput).replace(',', '.'));
    if (parsedTax > 30) {
      return showMessage('error', 'A taxa de serviço deve ficar entre 0% e 30%.');
    }
    setSavingSettings(true);
    try {
      const payload: RestaurantSettings = {
        ...settings,
        service_tax_percent: parsedTax,
        payment_methods_allowed: Array.from(new Set(['CASH', ...settings.payment_methods_allowed]))
      };
      const saved = await api.updateSettings(payload);
      setSettings(saved);
      setTaxInput(formatPercent(normalizePercent(saved.service_tax_percent)));
      await loadSettings(true);

      const disabled = PAYMENT_OPTIONS.filter(m => !saved.payment_methods_allowed.includes(m.key)).map(m => m.label);
      showMessage(
        'success',
        `Configurações salvas. Taxa de serviço: ${parsedTax > 0 ? formatPercent(parsedTax) + '%' : 'desativada'}.` +
          (disabled.length ? ` Desativados no caixa: ${disabled.join(', ')}.` : '')
      );
    } catch (err: any) {
      showMessage('error', err.message || 'Não foi possível salvar as configurações.');
    } finally {
      setSavingSettings(false);
    }
  }

  function togglePaymentMethod(methodKey: string) {
    if (methodKey === 'CASH') return;
    setSettings(prev => {
      const allowed = new Set(prev.payment_methods_allowed);
      if (allowed.has(methodKey)) allowed.delete(methodKey);
      else allowed.add(methodKey);
      allowed.add('CASH');
      return { ...prev, payment_methods_allowed: Array.from(allowed) };
    });
  }

  const categoriesList = Array.from(new Set(menuItems.map(m => m.category)));
  const previewTax = normalizePercent(String(taxInput).replace(',', '.'));
  const lowStockCount = inventory.filter(i => i.quantity <= i.min_quantity).length;

  const menuFiltrado = menuItems
    .filter(m => menuCategoryFilter === 'ALL' || m.category === menuCategoryFilter)
    .filter(m => m.name.toLowerCase().includes(menuSearch.toLowerCase()));

  const inventarioFiltrado = inventory
    .filter(i => cleanInventoryName(i.name).toLowerCase().includes(invSearch.toLowerCase()));

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Gestão do restaurante</h1>
          <div className="page-subtitle">Mesas, cardápio, estoque e configurações do estabelecimento.</div>
        </div>
        <div className="toolbar">
          <button onClick={loadAllAdminData} className="btn btn-outline btn-sm"><RefreshCw size={15} /> Atualizar</button>
        </div>
      </div>

      {message && (
        <div className={`alert ${message.type === 'success' ? 'alert-success' : 'alert-error'}`}>
          {message.type === 'success' ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}
          {message.text}
        </div>
      )}

      <div className="tabs">
        <button onClick={() => setActiveTab('tables')} className={`tab ${activeTab === 'tables' ? 'is-active' : ''}`}>
          <Grid size={16} /> Mesas <span className="tab-count">{tables.length}</span>
        </button>
        <button onClick={() => setActiveTab('menu')} className={`tab ${activeTab === 'menu' ? 'is-active' : ''}`}>
          <Utensils size={16} /> Cardápio <span className="tab-count">{menuItems.length}</span>
        </button>
        <button onClick={() => setActiveTab('inventory')} className={`tab ${activeTab === 'inventory' ? 'is-active' : ''}`}>
          <Package size={16} /> Estoque <span className="tab-count">{inventory.length}</span>
        </button>
        <button onClick={() => setActiveTab('users')} className={`tab ${activeTab === 'users' ? 'is-active' : ''}`}>
          <Users size={16} /> Usuários
        </button>
        <button onClick={() => setActiveTab('modules')} className={`tab ${activeTab === 'modules' ? 'is-active' : ''}`}>
          <Blocks size={16} /> Módulos
        </button>
        <button onClick={() => setActiveTab('license')} className={`tab ${activeTab === 'license' ? 'is-active' : ''}`}>
          <ShieldCheck size={16} /> Licença
        </button>
        <button onClick={() => setActiveTab('settings')} className={`tab ${activeTab === 'settings' ? 'is-active' : ''}`}>
          <Settings size={16} /> Configurações
        </button>
      </div>

      {/* ---------------------------------------------------------- MESAS */}
      {activeTab === 'tables' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div className="card card-pad">
            <h2 style={{ marginBottom: '12px' }}>Adicionar mesa</h2>
            <form onSubmit={handleAddTable} style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div className="field" style={{ flex: '1 1 140px' }}>
                <label className="label">Número da mesa</label>
                <input type="number" inputMode="numeric" placeholder="15" value={newTableNum} onChange={(e) => setNewTableNum(e.target.value)} className="input" required />
              </div>
              <div className="field" style={{ flex: '2 1 240px' }}>
                <label className="label">Nome (opcional)</label>
                <input type="text" placeholder="Mesa 15 - Varanda" value={newTableName} onChange={(e) => setNewTableName(e.target.value)} className="input" />
              </div>
              <button type="submit" className="btn btn-primary"><Plus size={16} /> Adicionar</button>
            </form>
          </div>

          <div className="card card-pad">
            <div className="list-meta">
              <span>{tables.length} mesa{tables.length === 1 ? '' : 's'} cadastrada{tables.length === 1 ? '' : 's'}</span>
            </div>
            <div className="grid-auto scroll-area scroll-table" style={{ alignContent: 'start' }}>
              {tables.map(table => (
                <div key={table.id} className="card card-pad" style={{ boxShadow: 'none' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
                    <div>
                      <div style={{ fontSize: '1rem', fontWeight: 600 }}>Mesa {String(table.number).padStart(2, '0')}</div>
                      <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>{table.name}</div>
                    </div>
                    <span className={`badge ${table.status === 'FREE' ? 'badge-free' : table.status === 'OCCUPIED' ? 'badge-occupied' : 'badge-pending'}`}>
                      {table.status === 'FREE' ? 'Livre' : table.status === 'OCCUPIED' ? 'Ocupada' : 'Pagamento'}
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: '8px', marginTop: '14px' }}>
                    <button
                      onClick={() => {
                        setEditingTable(table);
                        setEditTableNum(String(table.number));
                        setEditTableName(table.name);
                      }}
                      className="btn btn-outline btn-sm"
                      style={{ flex: 1 }}
                    >
                      <Pencil size={14} /> Editar
                    </button>
                    <button onClick={() => handleDeleteTable(table)} className="btn btn-danger-soft btn-sm" style={{ flex: 1 }}>
                      <Trash2 size={14} /> Excluir
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {editingTable && (
            <div className="modal-overlay">
              <div className="modal animate-fade-in">
                <div className="modal-head">
                  <h2>Editar mesa {editingTable.number}</h2>
                  <button onClick={() => setEditingTable(null)} className="btn-close"><X size={19} /></button>
                </div>
                <form onSubmit={handleUpdateTable} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                  <div className="field">
                    <label className="label">Número da mesa</label>
                    <input type="number" inputMode="numeric" value={editTableNum} onChange={(e) => setEditTableNum(e.target.value)} className="input" required />
                  </div>
                  <div className="field">
                    <label className="label">Nome exibido</label>
                    <input type="text" value={editTableName} onChange={(e) => setEditTableName(e.target.value)} className="input" required />
                  </div>
                  <div className="modal-actions">
                    <button type="button" onClick={() => setEditingTable(null)} className="btn btn-outline">Cancelar</button>
                    <button type="submit" className="btn btn-primary"><Save size={16} /> Salvar</button>
                  </div>
                </form>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ------------------------------------------------------- CARDÁPIO */}
      {activeTab === 'menu' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', gap: '10px', flex: '1 1 320px', flexWrap: 'wrap' }}>
              <div className="input-group" style={{ flex: '1 1 220px' }}>
                <span className="input-icon"><Search size={16} /></span>
                <input type="text" placeholder="Buscar produto" value={menuSearch} onChange={(e) => setMenuSearch(e.target.value)} className="input" />
                {menuSearch && <button onClick={() => setMenuSearch('')} className="input-clear" title="Limpar"><X size={15} /></button>}
              </div>
              <select value={menuCategoryFilter} onChange={(e) => setMenuCategoryFilter(e.target.value)} className="input" style={{ flex: '1 1 180px', maxWidth: '220px' }}>
                <option value="ALL">Todas as categorias</option>
                {categoriesList.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <button onClick={() => setShowAddMenuModal(true)} className="btn btn-primary"><Plus size={16} /> Novo produto</button>
          </div>

          <div className="card card-pad">
            <div className="list-meta">
              <span>{menuFiltrado.length} de {menuItems.length} produto(s)</span>
            </div>

            <div className="table-wrap scroll-area scroll-table">
              <table className="data-table table-sticky responsive-cards">
                <thead>
                  <tr>
                    <th>Produto</th>
                    <th>Categoria</th>
                    <th>Preço</th>
                    <th>Situação</th>
                    <th style={{ textAlign: 'right' }}>Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {menuFiltrado.map(item => (
                    <tr key={item.id}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{item.name}</div>
                        <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>{item.description || 'Sem descrição'}</div>
                      </td>
                      <td data-label="Categoria"><span className="badge badge-neutral">{item.category}</span></td>
                      <td data-label="Preço" className="money">R$ {Number(item.price).toFixed(2)}</td>
                      <td data-label="Situação">
                        <span className={`badge ${item.active !== false ? 'badge-free' : 'badge-neutral'}`}>
                          {item.active !== false ? 'Disponível' : 'Indisponível'}
                        </span>
                      </td>
                      <td data-label="Ações">
                        <div className="cell-actions">
                          <button onClick={() => setEditingMenu(item)} className="btn btn-outline btn-sm"><Pencil size={14} /> Editar</button>
                          <button onClick={() => handleDeleteMenuItem(item)} className="btn btn-danger-soft btn-sm btn-icon" title="Excluir"><Trash2 size={14} /></button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {menuFiltrado.length === 0 && (
                    <tr><td colSpan={5}><div className="empty-state">Nenhum produto encontrado.</div></td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {showAddMenuModal && (
            <div className="modal-overlay">
              <div className="modal animate-fade-in">
                <div className="modal-head">
                  <h2>Novo produto</h2>
                  <button onClick={() => setShowAddMenuModal(false)} className="btn-close"><X size={19} /></button>
                </div>
                <form onSubmit={handleAddMenuItem} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                  <div className="field">
                    <label className="label">Nome do prato ou bebida</label>
                    <input type="text" placeholder="Picanha na chapa 500g" value={newMenuForm.name} onChange={(e) => setNewMenuForm({ ...newMenuForm, name: e.target.value })} className="input" required />
                  </div>
                  <div className="field">
                    <label className="label">Categoria</label>
                    <input type="text" placeholder="Pratos Principais, Lanches, Bebidas..." value={newMenuForm.category} onChange={(e) => setNewMenuForm({ ...newMenuForm, category: e.target.value })} className="input" required />
                    <span className="hint">Categorias com "Bebida", "Drink" ou "Bar" vão automaticamente para a tela do Bar.</span>
                  </div>
                  <div className="field">
                    <label className="label">Preço de venda (R$)</label>
                    <input type="text" inputMode="decimal" placeholder="89.90" value={newMenuForm.price} onChange={(e) => setNewMenuForm({ ...newMenuForm, price: e.target.value })} className="input" required />
                  </div>
                  <div className="field">
                    <label className="label">Descrição curta</label>
                    <textarea placeholder="Acompanha farofa e vinagrete" value={newMenuForm.description} onChange={(e) => setNewMenuForm({ ...newMenuForm, description: e.target.value })} className="input" />
                  </div>
                  <MenuFiscalFields value={newMenuFiscal} onChange={setNewMenuFiscal} />
                  <div className="modal-actions">
                    <button type="button" onClick={() => setShowAddMenuModal(false)} className="btn btn-outline">Cancelar</button>
                    <button type="submit" className="btn btn-primary"><Save size={16} /> Salvar produto</button>
                  </div>
                </form>
              </div>
            </div>
          )}

          {editingMenu && (
            <div className="modal-overlay">
              <div className="modal animate-fade-in">
                <div className="modal-head">
                  <h2>Editar produto</h2>
                  <button onClick={() => setEditingMenu(null)} className="btn-close"><X size={19} /></button>
                </div>
                <form onSubmit={handleUpdateMenuItem} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                  <div className="field">
                    <label className="label">Nome</label>
                    <input type="text" value={editingMenu.name} onChange={(e) => setEditingMenu({ ...editingMenu, name: e.target.value })} className="input" required />
                  </div>
                  <div className="field">
                    <label className="label">Categoria</label>
                    <input type="text" value={editingMenu.category} onChange={(e) => setEditingMenu({ ...editingMenu, category: e.target.value })} className="input" required />
                  </div>
                  <div className="field">
                    <label className="label">Preço (R$)</label>
                    <input type="number" step="0.01" inputMode="decimal" value={editingMenu.price} onChange={(e) => setEditingMenu({ ...editingMenu, price: parseFloat(e.target.value) })} className="input" required />
                  </div>
                  <div className="field">
                    <label className="label">Descrição</label>
                    <textarea value={editingMenu.description} onChange={(e) => setEditingMenu({ ...editingMenu, description: e.target.value })} className="input" />
                  </div>
                  <label className="checkbox-row">
                    <input type="checkbox" checked={editingMenu.active !== false} onChange={(e) => setEditingMenu({ ...editingMenu, active: e.target.checked })} />
                    Disponível para venda no cardápio
                  </label>
                  <MenuFiscalFields value={editingMenu} onChange={v => setEditingMenu({ ...editingMenu, ...v })} />
                  <div className="modal-actions">
                    <button type="button" onClick={() => setEditingMenu(null)} className="btn btn-outline">Cancelar</button>
                    <button type="submit" className="btn btn-primary"><Save size={16} /> Salvar alterações</button>
                  </div>
                </form>
              </div>
            </div>
          )}
        </div>
      )}

      {/* -------------------------------------------------------- ESTOQUE */}
      {activeTab === 'inventory' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
            <div className="input-group" style={{ flex: '1 1 260px', maxWidth: '360px' }}>
              <span className="input-icon"><Search size={16} /></span>
              <input type="text" placeholder="Buscar insumo" value={invSearch} onChange={(e) => setInvSearch(e.target.value)} className="input" />
              {invSearch && <button onClick={() => setInvSearch('')} className="input-clear" title="Limpar"><X size={15} /></button>}
            </div>
            <div className="toolbar">
              {lowStockCount > 0 && <span className="badge badge-occupied"><AlertTriangle size={12} /> {lowStockCount} para repor</span>}
              <button onClick={() => setShowAddInvModal(true)} className="btn btn-primary"><Plus size={16} /> Novo insumo</button>
            </div>
          </div>

          <div className="card card-pad">
            <div className="list-meta">
              <span>{inventarioFiltrado.length} de {inventory.length} insumo(s)</span>
            </div>

            <div className="table-wrap scroll-area scroll-table">
              <table className="data-table table-sticky responsive-cards">
                <thead>
                  <tr>
                    <th>Insumo</th>
                    <th style={{ minWidth: '190px' }}>Estoque atual</th>
                    <th>Mínimo</th>
                    <th>Custo</th>
                    <th>Reposição rápida</th>
                    <th style={{ textAlign: 'right' }}>Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {inventarioFiltrado.map(item => {
                    const health = getStockHealth(item.quantity, item.min_quantity);
                    return (
                      <tr key={item.id}>
                        <td>
                          <div style={{ fontWeight: 600 }}>{cleanInventoryName(item.name)}</div>
                          <div className="hint">Medido em {unitLabel(item.unit)}</div>
                        </td>
                        <td data-label="Estoque atual">
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', width: '100%', minWidth: '140px' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
                              <span className="money" style={{ color: health.color }}>{formatQuantity(item.quantity, item.unit)}</span>
                              <span className="hint" style={{ color: health.color, fontWeight: 600 }}>{health.label}</span>
                            </div>
                            <div className="meter">
                              <div className="meter-fill" style={{ width: `${health.percent}%`, background: health.color }} />
                            </div>
                          </div>
                        </td>
                        <td data-label="Mínimo" style={{ color: 'var(--text-secondary)' }}>{formatQuantity(item.min_quantity, item.unit)}</td>
                        <td data-label="Custo" style={{ color: 'var(--text-secondary)' }}>R$ {Number(item.unit_price || 0).toFixed(2)}</td>
                        <td data-label="Reposição rápida">
                          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                            {restockSteps(item.unit).map(step => (
                              <button key={step.label} onClick={() => handleQuickRestock(item, step.amount)} className="btn btn-outline btn-sm">
                                {step.label}
                              </button>
                            ))}
                          </div>
                        </td>
                        <td data-label="Ações">
                          <div className="cell-actions">
                            <button onClick={() => setEditingInv({ ...item, name: cleanInventoryName(item.name) })} className="btn btn-outline btn-sm"><Pencil size={14} /> Editar</button>
                            <button onClick={() => handleDeleteInventory(item)} className="btn btn-danger-soft btn-sm btn-icon" title="Excluir"><Trash2 size={14} /></button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                  {inventarioFiltrado.length === 0 && (
                    <tr><td colSpan={6}><div className="empty-state">Nenhum insumo encontrado.</div></td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {(showAddInvModal || editingInv) && (
            <div className="modal-overlay">
              <div className="modal animate-fade-in">
                <div className="modal-head">
                  <h2>{editingInv ? 'Editar insumo' : 'Novo insumo'}</h2>
                  <button onClick={() => { setShowAddInvModal(false); setEditingInv(null); }} className="btn-close"><X size={19} /></button>
                </div>

                <form onSubmit={editingInv ? handleUpdateInventory : handleAddInventory} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                  <div className="field">
                    <label className="label">Nome do insumo</label>
                    <input
                      type="text"
                      placeholder="Queijo cheddar fatiado"
                      value={editingInv ? editingInv.name : newInvForm.name}
                      onChange={(e) => editingInv ? setEditingInv({ ...editingInv, name: e.target.value }) : setNewInvForm({ ...newInvForm, name: e.target.value })}
                      className="input"
                      required
                    />
                    <span className="hint">Não precisa escrever a unidade no nome; ela é escolhida abaixo.</span>
                  </div>

                  <div className="field">
                    <label className="label">Como este insumo é medido</label>
                    <select
                      value={editingInv ? editingInv.unit : newInvForm.unit}
                      onChange={(e) => editingInv ? setEditingInv({ ...editingInv, unit: e.target.value }) : setNewInvForm({ ...newInvForm, unit: e.target.value })}
                      className="input"
                    >
                      {UNIT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                    <span className="hint">
                      {UNIT_OPTIONS.find(o => o.value === (editingInv ? editingInv.unit : newInvForm.unit))?.hint}
                    </span>
                  </div>

                  <div className="form-grid-2">
                    <div className="field">
                      <label className="label">Quantidade atual</label>
                      <input
                        type="text"
                        inputMode="decimal"
                        placeholder="5000"
                        value={editingInv ? String(editingInv.quantity) : newInvForm.quantity}
                        onChange={(e) => editingInv ? setEditingInv({ ...editingInv, quantity: Number(e.target.value.replace(',', '.')) || 0 }) : setNewInvForm({ ...newInvForm, quantity: e.target.value })}
                        className="input"
                        required
                      />
                    </div>
                    <div className="field">
                      <label className="label">Alerta de reposição</label>
                      <input
                        type="text"
                        inputMode="decimal"
                        placeholder="1000"
                        value={editingInv ? String(editingInv.min_quantity) : newInvForm.min_quantity}
                        onChange={(e) => editingInv ? setEditingInv({ ...editingInv, min_quantity: Number(e.target.value.replace(',', '.')) || 0 }) : setNewInvForm({ ...newInvForm, min_quantity: e.target.value })}
                        className="input"
                      />
                    </div>
                  </div>

                  <div className="field">
                    <label className="label">Preço de custo por {unitLabel(editingInv ? editingInv.unit : newInvForm.unit)} (R$)</label>
                    <input
                      type="text"
                      inputMode="decimal"
                      placeholder="0.06"
                      value={editingInv ? String(editingInv.unit_price ?? '') : newInvForm.unit_price}
                      onChange={(e) => editingInv ? setEditingInv({ ...editingInv, unit_price: Number(e.target.value.replace(',', '.')) || 0 }) : setNewInvForm({ ...newInvForm, unit_price: e.target.value })}
                      className="input"
                    />
                  </div>

                  <div className="modal-actions">
                    <button type="button" onClick={() => { setShowAddInvModal(false); setEditingInv(null); }} className="btn btn-outline">Cancelar</button>
                    <button type="submit" className="btn btn-primary"><Save size={16} /> Salvar</button>
                  </div>
                </form>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ------------------------------------------------------- USUÁRIOS */}
      {activeTab === 'users' && <UsersPanel onMessage={showMessage} />}

      {/* -------------------------------------------------------- MÓDULOS */}
      {activeTab === 'modules' && <FiscalModulePanel onMessage={showMessage} />}

      {/* -------------------------------------------------------- LICENÇA */}
      {activeTab === 'license' && <LicensePanel onMessage={showMessage} />}

      {/* -------------------------------------------------- CONFIGURAÇÕES */}
      {/* Centralizado: coluna estreita no meio da tela, mais confortável de ler */}
      {activeTab === 'settings' && (
        <div style={{ width: '100%', maxWidth: '720px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <section className="card card-pad" aria-labelledby="theme-title">
            <h2 id="theme-title" className="section-title"><Palette size={18} color="var(--text-secondary)" /> Aparência</h2>
            <p className="hint" style={{ margin: '4px 0 14px' }}>Vale para todos os aparelhos conectados. Só o administrador pode mudar.</p>
            <div className="choice-list" role="radiogroup" aria-label="Tema da interface">
              {THEME_OPTIONS.map(({ key, label, hint, Icon }) => {
                const selected = settings.theme === key;
                return (
                  <button
                    key={key}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => handleThemeChange(key)}
                    className={`choice ${selected ? 'is-selected' : ''}`}
                  >
                    <Icon size={20} />
                    <span className="choice-text">
                      <span className="choice-label">{label}</span>
                      <span className="hint">{hint}</span>
                    </span>
                    {selected && <CheckCircle2 size={18} className="choice-check" />}
                  </button>
                );
              })}
            </div>
          </section>

          <form onSubmit={handleSaveSettings} className="card card-pad" style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            <div className="section">
              <h2 className="section-title"><Building2 size={18} color="var(--text-secondary)" /> Dados do estabelecimento</h2>
              <p className="hint" style={{ marginBottom: '14px' }}>Aparecem no cupom e na pré-conta entregue ao cliente.</p>

              <div className="form-grid">
                <div className="field">
                  <label className="label">Nome do restaurante</label>
                  <input type="text" value={settings.restaurant_name} onChange={(e) => setSettings({ ...settings, restaurant_name: e.target.value })} className="input" required />
                </div>
                <div className="field">
                  <label className="label">CNPJ</label>
                  <input type="text" inputMode="numeric" value={settings.cnpj} onChange={(e) => setSettings({ ...settings, cnpj: e.target.value })} className="input" />
                </div>
                <div className="field">
                  <label className="label">Telefone / WhatsApp</label>
                  <input type="tel" inputMode="tel" value={settings.phone} onChange={(e) => setSettings({ ...settings, phone: e.target.value })} className="input" />
                </div>
                <div className="field">
                  <label className="label">Endereço</label>
                  <input type="text" value={settings.address} onChange={(e) => setSettings({ ...settings, address: e.target.value })} className="input" />
                </div>
              </div>
            </div>

            <div className="section">
              <h2 className="section-title"><Percent size={18} color="var(--text-secondary)" /> Taxa de serviço (gorjeta do garçom)</h2>
              <p className="hint" style={{ marginBottom: '14px' }}>
                Usada no caixa, na pré-conta, no cupom e nos relatórios. Use <strong>0</strong> para desativar.
              </p>

              <div style={{ display: 'flex', gap: '14px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <div className="field" style={{ width: '150px' }}>
                  <label className="label">Percentual (%)</label>
                  <input type="number" min="0" max="30" step="0.5" inputMode="decimal" value={taxInput} onChange={(e) => setTaxInput(e.target.value)} className="input" required />
                </div>
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', paddingBottom: '4px' }}>
                  {[0, 5, 10, 12, 15].map(v => (
                    <button key={v} type="button" onClick={() => setTaxInput(String(v))} className={`btn btn-sm ${previewTax === v ? 'btn-primary' : 'btn-outline'}`}>
                      {v === 0 ? 'Sem taxa' : `${v}%`}
                    </button>
                  ))}
                </div>
              </div>

              <div className="alert alert-info" style={{ marginTop: '12px' }}>
                <Percent size={16} />
                {previewTax > 0
                  ? `Em uma conta de R$ 100,00 o cliente pagará R$ ${(100 + previewTax).toFixed(2)} quando a taxa for aceita.`
                  : 'A taxa de serviço está desativada: o caixa cobrará apenas o consumo.'}
              </div>
            </div>

            <div className="section">
              <h2 className="section-title"><CreditCard size={18} color="var(--text-secondary)" /> Formas de pagamento aceitas</h2>
              <p className="hint" style={{ marginBottom: '14px' }}>O que estiver desmarcado aqui deixa de aparecer na tela do caixa.</p>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div className="card card-pad" style={{ boxShadow: 'none', background: 'var(--bg-subtle)', padding: '12px 14px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px' }}>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>Dinheiro</div>
                      <div className="hint">Obrigatório por lei</div>
                    </div>
                    <span className="badge badge-free">Sempre ativo</span>
                  </div>
                </div>

                {PAYMENT_OPTIONS.map(m => {
                  const enabled = settings.payment_methods_allowed.includes(m.key);
                  return (
                    <label key={m.key} className="card card-pad" style={{ boxShadow: 'none', cursor: 'pointer', padding: '12px 14px', borderColor: enabled ? 'var(--brand)' : 'var(--border)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px' }}>
                        <div>
                          <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>{m.label}</div>
                          <div className="hint">{enabled ? m.hint : 'Não aparece no caixa'}</div>
                        </div>
                        <input
                          type="checkbox"
                          checked={enabled}
                          onChange={() => togglePaymentMethod(m.key)}
                          style={{ width: '22px', height: '22px', accentColor: 'var(--brand)', cursor: 'pointer', flexShrink: 0 }}
                        />
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>

            <button type="submit" className="btn btn-primary btn-block btn-lg" disabled={savingSettings}>
              <Save size={17} /> {savingSettings ? 'Salvando...' : 'Salvar configurações'}
            </button>
          </form>

          <form onSubmit={handleChangeCredentials} className="card card-pad" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div>
              <h2 className="section-title"><KeyRound size={18} color="var(--text-secondary)" /> Meu usuário e senha</h2>
              <p className="hint" style={{ marginTop: '4px' }}>Deixe o novo usuário em branco para manter o atual. Mínimo de 8 caracteres na senha.</p>
            </div>

            <div className="form-grid">
              <div className="field">
                <label className="label">Senha atual</label>
                <input type="password" placeholder="Senha usada hoje" value={credForm.currentPassword} onChange={(e) => setCredForm({ ...credForm, currentPassword: e.target.value })} className="input" required />
              </div>
              <div className="field">
                <label className="label">Novo usuário</label>
                <input type="text" placeholder="Opcional" value={credForm.newUsername} onChange={(e) => setCredForm({ ...credForm, newUsername: e.target.value })} className="input" />
              </div>
              <div className="field">
                <label className="label">Nova senha</label>
                <input type="password" value={credForm.newPassword} onChange={(e) => setCredForm({ ...credForm, newPassword: e.target.value })} className="input" required />
              </div>
              <div className="field">
                <label className="label">Repita a nova senha</label>
                <input type="password" value={credForm.confirmPassword} onChange={(e) => setCredForm({ ...credForm, confirmPassword: e.target.value })} className="input" required />
              </div>
            </div>

            <button type="submit" className="btn btn-outline btn-block"><Save size={16} /> Salvar novo acesso</button>
          </form>

          <SupervisorPinSettings onMessage={showMessage} />
        </div>
      )}
    </div>
  );
};
