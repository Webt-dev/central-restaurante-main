import type { Table, MenuItem, Order, InventoryItem, DailyReport, SystemInfo, RestaurantSettings, ManagedUser } from '../types';
import { getToken, clearSession, setSession, type Session, type UserRole } from './session';

/**
 * Cliente HTTP da API.
 *
 * Não existe mais login automático nem senha embutida no código: cada
 * aparelho entra com o usuário de quem está operando (tela de login). Se o
 * servidor responder 401, a sessão local é descartada e o app volta ao login.
 */
/** Erro da API com o status HTTP e o código estável enviado pelo servidor (ex.: SUPERVISOR_REQUIRED). */
export class ApiError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export interface ItemChangeOptions {
  reason?: string;
  supervisor_pin?: string;
}

export interface CashMovement {
  id: string;
  type: 'SANGRIA' | 'SUPRIMENTO';
  amount: number;
  reason: string;
  user_name?: string;
  created_at: string;
}

export interface CashierSession {
  id: string;
  opened_at: string;
  opened_by_name?: string;
  initial_balance: number;
  total_sales: number;
  total_cash: number;
  total_card: number;
  total_pix: number;
  cash: {
    initial_balance: number;
    cash_sales: number;
    suprimentos: number;
    sangrias: number;
    expected_cash: number;
    movements: CashMovement[];
  };
}

async function fetchWithTimeout(endpoint: string, options: RequestInit = {}, timeoutMs = 8000): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const token = getToken();

  let res: Response;
  try {
    res = await fetch(`/api${endpoint}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options.headers
      },
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401 && token) {
    clearSession();
  }

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new ApiError(errData.details || errData.error || `HTTP ${res.status}`, res.status, errData.code);
  }

  return await res.json();
}

export const api = {
  /**
   * Mesas. Antes, se o servidor falhasse, o app inventava 10 mesas falsas e o
   * garçom lançava pedido numa mesa que não existia. Agora o erro sobe.
   */
  async getTables(): Promise<Table[]> {
    const dados = await fetchWithTimeout('/tables');
    return Array.isArray(dados) ? dados : [];
  },

  async updateTableStatus(tableId: string, status: 'FREE' | 'OCCUPIED' | 'PAYMENT_PENDING'): Promise<Table> {
    return await fetchWithTimeout(`/tables/${tableId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status })
    });
  },

  /**
   * Cardápio. Propaga o erro em vez de esconder com [], para a tela poder
   * mostrar "não foi possível carregar" e oferecer nova tentativa.
   */
  async getMenuItems(): Promise<MenuItem[]> {
    const dados = await fetchWithTimeout('/menu-items');
    return Array.isArray(dados) ? dados : [];
  },

  async createOrder(tableId: string, items: { menu_item_id: string; quantity: number; notes?: string }[], offline_sync_id?: string) {
    return await fetchWithTimeout('/orders', {
      method: 'POST',
      body: JSON.stringify({ table_id: tableId, items, offline_sync_id })
    });
  },

  /** Envia um lote de pedidos guardados no aparelho (idempotente por offline_sync_id). */
  async syncOrders(batch: { table_id: string; offline_sync_id: string; items: { menu_item_id: string; quantity: number; notes?: string }[]; notes?: string }[]): Promise<{ syncedCount: number; errors: { offline_sync_id: string; error: string }[] }> {
    return await fetchWithTimeout('/orders/sync-batch', {
      method: 'POST',
      body: JSON.stringify({ batch })
    }, 15000);
  },

  async getKitchenQueue(): Promise<Order[]> {
    const dados = await fetchWithTimeout('/kitchen/queue');
    return Array.isArray(dados) ? dados : [];
  },

  async getBarQueue(): Promise<Order[]> {
    const dados = await fetchWithTimeout('/kitchen/bar-queue');
    return Array.isArray(dados) ? dados : [];
  },

  async updateKitchenItemStatus(itemId: string, status: string) {
    return await fetchWithTimeout(`/kitchen/item/${itemId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status })
    });
  },

  async updateOrderBatchStatus(orderId: string, status: string, filterType?: 'FOOD' | 'DRINK' | 'BAR') {
    return await fetchWithTimeout(`/kitchen/order/${orderId}/batch-status`, {
      method: 'PATCH',
      body: JSON.stringify({ status, filterType })
    });
  },

  async deleteOrderItem(itemId: string, options: ItemChangeOptions = {}) {
    return await fetchWithTimeout(`/orders/item/${itemId}`, { method: 'DELETE', body: JSON.stringify(options) });
  },

  async updateOrderItemQuantity(itemId: string, quantity: number, options: ItemChangeOptions = {}) {
    return await fetchWithTimeout(`/orders/item/${itemId}/quantity`, {
      method: 'PATCH',
      body: JSON.stringify({ quantity, ...options })
    });
  },

  // ==========================================
  // GAVETA DO CAIXA
  // ==========================================

  async getCashierSession(): Promise<CashierSession | null> {
    return await fetchWithTimeout('/cashier/session');
  },

  async openCashier(initial_balance: number): Promise<CashierSession> {
    return await fetchWithTimeout('/cashier/session/open', { method: 'POST', body: JSON.stringify({ initial_balance }) });
  },

  async addCashMovement(type: 'SANGRIA' | 'SUPRIMENTO', amount: number, reason: string): Promise<CashMovement> {
    return await fetchWithTimeout('/cashier/cash-movements', { method: 'POST', body: JSON.stringify({ type, amount, reason }) });
  },

  async getTableBill(tableId: string) {
    return await fetchWithTimeout(`/orders/table/${tableId}/bill`);
  },

  async processPayment(tableId: string, payments: { method: string; amount: number; amount_paid?: number }[], include_tip: boolean = false) {
    return await fetchWithTimeout('/cashier/payment', {
      method: 'POST',
      body: JSON.stringify({ table_id: tableId, payments, include_tip })
    });
  },

  async reprintReceipt(orderId: string): Promise<{ receipt_text: string }> {
    return await fetchWithTimeout(`/cashier/receipt/order/${orderId}`);
  },

  async printTableBill(tableId: string): Promise<{ success: boolean; receipt_text: string; receipt_file: string }> {
    return await fetchWithTimeout(`/cashier/table-bill/${tableId}/print`);
  },

  async getDailyReport(): Promise<DailyReport> {
    try {
      return await fetchWithTimeout('/cashier/report');
    } catch (err) {
      console.warn('Erro ao obter relatório do backend:', err);
      return {
        date: new Date().toISOString().split('T')[0]!,
        cashier_session: null,
        total_sales: 0,
        total_sales_subtotal: 0,
        total_sales_tips: 0,
        total_orders_closed: 0,
        by_payment_method: { CASH: 0, CREDIT_CARD: 0, DEBIT_CARD: 0, PIX: 0 },
        table_orders_detail: [],
        inventory_alerts: []
      };
    }
  },

  async closeDailyExpedient(counted_cash?: number, note?: string): Promise<any> {
    return await fetchWithTimeout('/cashier/close-expedient', {
      method: 'POST',
      body: JSON.stringify({ counted_cash, note: note || undefined })
    }, 15000);
  },

  async getInventory(): Promise<InventoryItem[]> {
    const dados = await fetchWithTimeout('/inventory');
    return Array.isArray(dados) ? dados : [];
  },

  async getSystemInfo(): Promise<SystemInfo> {
    try {
      return await fetchWithTimeout('/system/info');
    } catch {
      return {
        local_ip: window.location.hostname,
        frontend_url: `http://${window.location.hostname}:5173`,
        backend_url: `http://${window.location.hostname}:3000`,
        connected_devices: [],
        total_connected: 0
      };
    }
  },

  // ==========================================
  // ADMINISTRAÇÃO
  // ==========================================

  async addTable(number: number, name?: string): Promise<Table> {
    return await fetchWithTimeout('/admin/tables', {
      method: 'POST',
      body: JSON.stringify({ number, name })
    });
  },

  async updateTable(id: string, number: number, name: string): Promise<Table> {
    return await fetchWithTimeout(`/admin/tables/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ number, name })
    });
  },

  async deleteTable(id: string): Promise<any> {
    return await fetchWithTimeout(`/admin/tables/${id}`, { method: 'DELETE' });
  },

  async addMenuItem(data: { name: string; description: string; price: number; category: string }): Promise<MenuItem> {
    return await fetchWithTimeout('/admin/menu', {
      method: 'POST',
      body: JSON.stringify(data)
    });
  },

  async updateMenuItem(id: string, data: { name: string; description: string; price: number; category: string; active?: boolean }): Promise<MenuItem> {
    return await fetchWithTimeout(`/admin/menu/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data)
    });
  },

  async deleteMenuItem(id: string): Promise<any> {
    return await fetchWithTimeout(`/admin/menu/${id}`, { method: 'DELETE' });
  },

  async addInventoryItem(data: { name: string; unit: string; quantity: number; min_quantity: number; unit_price: number }): Promise<InventoryItem> {
    return await fetchWithTimeout('/admin/inventory', {
      method: 'POST',
      body: JSON.stringify(data)
    });
  },

  async updateInventoryItem(id: string, data: { name: string; unit: string; quantity: number; min_quantity: number; unit_price: number }): Promise<InventoryItem> {
    return await fetchWithTimeout(`/admin/inventory/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data)
    });
  },

  async restockInventoryItem(id: string, quantity: number): Promise<InventoryItem> {
    return await fetchWithTimeout(`/admin/inventory/${id}/restock`, {
      method: 'POST',
      body: JSON.stringify({ quantity })
    });
  },

  async deleteInventoryItem(id: string): Promise<any> {
    return await fetchWithTimeout(`/admin/inventory/${id}`, { method: 'DELETE' });
  },

  async getSettings(): Promise<RestaurantSettings> {
    try {
      return await fetchWithTimeout('/admin/settings');
    } catch {
      return {
        restaurant_name: 'Central Restaurante',
        cnpj: '',
        phone: '',
        address: '',
        service_tax_percent: 10,
        payment_methods_allowed: ['CASH', 'CREDIT_CARD', 'DEBIT_CARD', 'PIX'],
        theme: 'system'
      };
    }
  },

  async updateSettings(data: Partial<RestaurantSettings>): Promise<RestaurantSettings> {
    return await fetchWithTimeout('/admin/settings', {
      method: 'PUT',
      body: JSON.stringify(data)
    });
  },

  /** Troca usuário/senha da própria conta. O servidor devolve um token novo. */
  async changeOwnCredentials(data: { currentPassword: string; newUsername?: string; newPassword: string }): Promise<void> {
    const result = await fetchWithTimeout('/auth/me/credentials', {
      method: 'POST',
      body: JSON.stringify(data)
    });
    setSession({ token: result.token, user: result.user });
  },

  /** PIN de supervisor (somente ADMIN). pin = null remove. */
  async setOwnPin(currentPassword: string, pin: string | null): Promise<void> {
    await fetchWithTimeout('/auth/me/pin', { method: 'POST', body: JSON.stringify({ currentPassword, pin }) });
  },

  // ==========================================
  // USUÁRIOS (somente ADMIN)
  // ==========================================

  async listUsers(): Promise<ManagedUser[]> {
    const dados = await fetchWithTimeout('/auth/users');
    return Array.isArray(dados) ? dados : [];
  },

  async createUser(data: { name: string; username: string; role: UserRole; password: string }): Promise<ManagedUser> {
    return await fetchWithTimeout('/auth/users', { method: 'POST', body: JSON.stringify(data) });
  },

  async updateUser(id: string, data: { name: string; role: UserRole; active: boolean }): Promise<ManagedUser> {
    return await fetchWithTimeout(`/auth/users/${id}`, { method: 'PUT', body: JSON.stringify(data) });
  },

  async resetUserPassword(id: string, password: string): Promise<ManagedUser> {
    return await fetchWithTimeout(`/auth/users/${id}/reset-password`, { method: 'POST', body: JSON.stringify({ password }) });
  },

  // ==========================================
  // MÓDULO FISCAL (NFC-e)
  // ==========================================

  async getFiscalConfig(): Promise<any> {
    try {
      return await fetchWithTimeout('/fiscal/config');
    } catch {
      return {
        cnpj: '', inscricao_estadual: '', razao_social: '', nome_fantasia: '',
        logradouro: '', numero_endereco: '', bairro: '', codigo_municipio: '',
        nome_municipio: '', uf: 'SP', cep: '', telefone: '',
        regime_tributario: '1', serie_nfce: 1, ambiente: 2,
        csc_id: '', csc_configurado: false, url_consulta: '',
        cfop_padrao: '5102', csosn_padrao: '102', cst_pis_cofins: '07',
        emissao_ativa: false
      };
    }
  },

  async updateFiscalConfig(data: any): Promise<any> {
    return await fetchWithTimeout('/fiscal/config', {
      method: 'PUT',
      body: JSON.stringify(data)
    });
  },

  async validarFiscalConfig(): Promise<{ pronto: boolean; pendencias: string[] }> {
    try {
      return await fetchWithTimeout('/fiscal/config/validar');
    } catch {
      return { pronto: false, pendencias: ['Não foi possível consultar o servidor.'] };
    }
  },

  async getFiscalDocumentos(data?: string): Promise<any[]> {
    try {
      const dados = await fetchWithTimeout(`/fiscal/documentos${data ? `?data=${data}` : ''}`);
      return Array.isArray(dados) ? dados : [];
    } catch {
      return [];
    }
  },

  async getFiscalDocumento(id: string): Promise<any> {
    return await fetchWithTimeout(`/fiscal/documentos/${id}`);
  },

  async getFiscalXml(id: string): Promise<{ xml: string }> {
    return await fetchWithTimeout(`/fiscal/documentos/${id}/xml`);
  },

  async getFiscalResumo(data?: string): Promise<any> {
    try {
      return await fetchWithTimeout(`/fiscal/resumo${data ? `?data=${data}` : ''}`);
    } catch {
      return {
        data: new Date().toISOString().split('T')[0]!,
        total_documentos: 0,
        valor_total: 0,
        por_status: { PENDENTE: 0, GERADO: 0, AUTORIZADO: 0, REJEITADO: 0, CANCELADO: 0 },
        ambiente: 2,
        emissao_ativa: false
      };
    }
  },

  async exportarFiscal(data_inicio: string, data_fim: string): Promise<any> {
    return await fetchWithTimeout('/fiscal/exportar', {
      method: 'POST',
      body: JSON.stringify({ data_inicio, data_fim })
    }, 20000);
  },

  async autorizarFiscal(id: string, protocolo: string): Promise<any> {
    return await fetchWithTimeout(`/fiscal/documentos/${id}/autorizar`, {
      method: 'POST',
      body: JSON.stringify({ protocolo })
    });
  },

  async rejeitarFiscal(id: string, motivo: string): Promise<any> {
    return await fetchWithTimeout(`/fiscal/documentos/${id}/rejeitar`, {
      method: 'POST',
      body: JSON.stringify({ motivo })
    });
  },

  // ==========================================
  // SESSÃO
  // ==========================================

  async setupStatus(): Promise<{ needsSetup: boolean }> {
    return await fetchWithTimeout('/auth/setup-status');
  },

  async setup(name: string, username: string, password: string): Promise<Session> {
    const data = await fetchWithTimeout('/auth/setup', {
      method: 'POST',
      body: JSON.stringify({ name, username, password })
    });
    const session: Session = { token: data.token, user: data.user };
    setSession(session);
    return session;
  },

  async login(username: string, password: string): Promise<Session> {
    const data = await fetchWithTimeout('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password })
    });
    const session: Session = { token: data.token, user: data.user, mustChangePassword: Boolean(data.mustChangePassword) };
    setSession(session);
    return session;
  },

  async logout(): Promise<void> {
    try {
      await fetchWithTimeout('/auth/logout', { method: 'POST' }, 3000);
    } catch {
      // Mesmo sem servidor, a sessão local é encerrada.
    }
    clearSession();
  }
};
