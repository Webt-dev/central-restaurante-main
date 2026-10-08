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

export type StatusFiscal = 'PENDENTE' | 'AUTORIZADO' | 'CONTINGENCIA' | 'REJEITADO' | 'CANCELADO' | 'ERRO';

export interface FiscalConfig {
  enabled: boolean;
  provider: 'acbr' | 'simulacao';
  acbr_host: string;
  acbr_port: number;
  ambiente: 1 | 2;
  serie: number;
  cnpj: string;
  ie: string;
  razao_social: string;
  nome_fantasia: string;
  crt: '' | '1' | '2' | '3' | '4';
  logradouro: string;
  numero: string;
  bairro: string;
  codigo_municipio: string;
  municipio: string;
  uf: string;
  cep: string;
  telefone: string;
  cfop_padrao: string;
  csosn_padrao: string;
  cst_icms_padrao: string;
  cst_pis_cofins_padrao: string;
  origem_padrao: string;
}

export interface FiscalConfigResponse {
  config: FiscalConfig;
  pendencias: string[];
  produtos_sem_ncm: { id: string; name: string; category: string }[];
}

export interface FiscalStatus {
  enabled: boolean;
  provider: string;
  ambiente: number;
  por_status: Record<StatusFiscal, number>;
  contingencia_mais_antiga: string | null;
  alerta_contingencia: boolean;
  pendencias: string[];
}

export interface DocumentoFiscal {
  id: string;
  table_number: number | null;
  ambiente: number;
  serie: number;
  numero: number;
  chave: string | null;
  status: StatusFiscal;
  tp_emis: number;
  valor_total: number;
  protocolo: string | null;
  motivo: string | null;
  contingencia_desde: string | null;
  autorizado_em: string | null;
  created_at: string;
}

export type LicenseState = 'TRIAL' | 'TRIAL_EXPIRED' | 'ACTIVE' | 'DUE_SOON' | 'GRACE' | 'BLOCKED' | 'INVALID' | 'CLOCK';

export interface LicenseStatus {
  /** Segredo deste computador (só ADMIN). O celular o envia ao buscar a licença no servidor. */
  deviceSecret?: string | null;
  state: LicenseState;
  blocked: boolean;
  message: string;
  daysLeft?: number;
  daysOverdue?: number;
  daysUntilBlock?: number;
  enforced: boolean;
  // Só para ADMIN:
  clientId?: string | null;
  clientName?: string | null;
  plan?: string | null;
  features?: string[];
  paidUntil?: string | null;
  validUntil?: string | null;
  serverUrl?: string | null;
  fingerprint?: string;
  lastRefreshAt?: string | null;
  lastRefreshError?: string | null;
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

  async processPayment(tableId: string, payments: { method: string; amount: number; amount_paid?: number }[], include_tip: boolean = false, cpf_consumidor?: string) {
    return await fetchWithTimeout('/cashier/payment', {
      method: 'POST',
      body: JSON.stringify({ table_id: tableId, payments, include_tip, cpf_consumidor: cpf_consumidor || undefined })
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

  async addMenuItem(data: { name: string; description: string; price: number; category: string } & Record<string, unknown>): Promise<MenuItem> {
    return await fetchWithTimeout('/admin/menu', {
      method: 'POST',
      body: JSON.stringify(data)
    });
  },

  async updateMenuItem(id: string, data: { name: string; description: string; price: number; category: string; active?: boolean } & Record<string, unknown>): Promise<MenuItem> {
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
  // MÓDULO FISCAL (NFC-e) — opcional
  // ==========================================

  async getFiscalStatus(): Promise<FiscalStatus> {
    return await fetchWithTimeout('/fiscal/status');
  },

  async getFiscalConfig(): Promise<FiscalConfigResponse> {
    return await fetchWithTimeout('/fiscal/config');
  },

  async updateFiscalConfig(data: Partial<FiscalConfig>): Promise<FiscalConfigResponse> {
    return await fetchWithTimeout('/fiscal/config', { method: 'PUT', body: JSON.stringify(data) });
  },

  async testarFiscal(): Promise<{ online: boolean; motivo: string }> {
    return await fetchWithTimeout('/fiscal/testar-conexao', { method: 'POST' }, 50000);
  },

  async ativarFiscal(enabled: boolean): Promise<{ enabled: boolean }> {
    return await fetchWithTimeout('/fiscal/ativar', { method: 'POST', body: JSON.stringify({ enabled }) }, 50000);
  },

  async getFiscalDocumentos(data?: string): Promise<DocumentoFiscal[]> {
    const dados = await fetchWithTimeout(`/fiscal/documentos${data ? `?data=${data}` : ''}`);
    return Array.isArray(dados) ? dados : [];
  },

  async reprocessarFiscal(id: string): Promise<DocumentoFiscal> {
    return await fetchWithTimeout(`/fiscal/documentos/${id}/reprocessar`, { method: 'POST' }, 50000);
  },

  async cancelarFiscal(id: string, justificativa: string): Promise<DocumentoFiscal> {
    return await fetchWithTimeout(`/fiscal/documentos/${id}/cancelar`, { method: 'POST', body: JSON.stringify({ justificativa }) }, 50000);
  },

  // ==========================================
  // LICENÇA
  // ==========================================

  async getLicenseStatus(): Promise<LicenseStatus> {
    return await fetchWithTimeout('/license/status');
  },

  async activateLicense(server_url: string, client_id: string, activation_code: string): Promise<LicenseStatus> {
    return await fetchWithTimeout('/license/activate', { method: 'POST', body: JSON.stringify({ server_url, client_id, activation_code }) }, 20000);
  },

  /** Registra a avaliação de 7 dias no servidor de licenças (sem internet, fica na fila e segue a avaliação local). */
  async registerTrial(data: { server_url?: string; name: string; cnpj: string; email: string; consent: boolean }): Promise<LicenseStatus> {
    return await fetchWithTimeout('/license/trial', { method: 'POST', body: JSON.stringify(data) }, 25000);
  },

  async refreshLicense(): Promise<LicenseStatus> {
    return await fetchWithTimeout('/license/refresh', { method: 'POST' }, 20000);
  },

  async installLicense(token: string): Promise<LicenseStatus> {
    return await fetchWithTimeout('/license/install', { method: 'POST', body: JSON.stringify({ token }) });
  },

  /**
   * Renovação sem internet na central: ESTE aparelho (o celular do ADMIN, no 4G)
   * busca a licença direto no servidor de licenças e a entrega à central pela rede local.
   */
  async fetchLicenseFromCloud(serverUrl: string, clientId: string, fingerprint: string, deviceSecret?: string | null): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(`${serverUrl}/v1/licenses/${encodeURIComponent(clientId)}?hw=${fingerprint}`, {
        signal: controller.signal,
        headers: deviceSecret ? { 'x-device-secret': deviceSecret } : undefined
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.token) throw new Error(body.error || `Servidor de licenças respondeu ${res.status}.`);
      return body.token as string;
    } catch (err: any) {
      if (err?.name === 'AbortError' || err instanceof TypeError) {
        throw new Error('Este aparelho também não alcançou o servidor de licenças. Use os dados móveis (4G) ou o arquivo de licença.');
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  },

  // ==========================================
  // SESSÃO
  // ==========================================

  async setupStatus(): Promise<{ needsSetup: boolean; needsInstallCode?: boolean }> {
    return await fetchWithTimeout('/auth/setup-status');
  },

  async setup(name: string, username: string, password: string, installCode?: string): Promise<Session> {
    const data = await fetchWithTimeout('/auth/setup', {
      method: 'POST',
      body: JSON.stringify({ name, username, password, installCode })
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
