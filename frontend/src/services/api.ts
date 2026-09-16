import type { Table, MenuItem, Order, InventoryItem, DailyReport, SystemInfo, RestaurantSettings } from '../types';

let activeToken: string | null = null;

/**
 * Promessa única de login em andamento.
 *
 * CORREÇÃO DE BUG: a versão anterior usava um booleano `isAuthenticating` e,
 * quando uma segunda chamada via esse booleano ligado, ela simplesmente
 * retornava — seguindo em frente SEM token. Como a tela do garçom dispara
 * getTables() e getMenuItems() em paralelo, a segunda chamada saía sem
 * Authorization, o backend respondia 401 e o catch devolvia lista vazia.
 * Resultado: "0 produtos" no primeiro carregamento e tudo certo ao voltar
 * na tela (aí o token já existia).
 *
 * Agora guardamos a própria Promise: quem chegar durante o login espera ela
 * terminar em vez de seguir sem credencial.
 */
let authPromise: Promise<void> | null = null;

export function setAuthToken(token: string) {
  activeToken = token;
}

export function clearAuthToken() {
  activeToken = null;
  authPromise = null;
}

const CREDENCIAIS = {
  ADMIN: { username: 'admin', password: '123456' },
  CASHIER: { username: 'caixa', password: 'caixa123' },
  WAITER: { username: 'garcom', password: 'garcom123' },
  KITCHEN: { username: 'cozinha', password: 'cozinha123' }
};

async function ensureAuth(role: 'ADMIN' | 'CASHIER' | 'WAITER' | 'KITCHEN' = 'ADMIN'): Promise<void> {
  if (activeToken) return;

  // Já existe um login em andamento: espera o mesmo, não inicia outro.
  if (authPromise) return authPromise;

  authPromise = (async () => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);

      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(CREDENCIAIS[role]),
        signal: controller.signal
      });

      clearTimeout(timer);

      if (res.ok) {
        const data = await res.json();
        if (data?.token) activeToken = data.token;
      } else {
        console.warn('Login automático falhou:', res.status);
      }
    } catch (err) {
      console.warn('Não foi possível autenticar automaticamente:', err);
    } finally {
      // Libera para uma nova tentativa em chamadas futuras.
      authPromise = null;
    }
  })();

  return authPromise;
}

async function fetchWithTimeout(endpoint: string, options: RequestInit = {}, timeoutMs = 8000): Promise<any> {
  await ensureAuth();

  const executar = async (): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(`/api${endpoint}`, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...(activeToken ? { Authorization: `Bearer ${activeToken}` } : {}),
          ...options.headers
        },
        signal: controller.signal
      });
      return res;
    } finally {
      clearTimeout(timer);
    }
  };

  let res = await executar();

  // Token expirado ou ausente: autentica de novo e repete uma única vez.
  if (res.status === 401 || res.status === 403) {
    activeToken = null;
    authPromise = null;
    await ensureAuth();

    if (activeToken) {
      res = await executar();
    }
  }

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData.error || `HTTP ${res.status}`);
  }

  return await res.json();
}

export const api = {
  async getTables(): Promise<Table[]> {
    try {
      const dados = await fetchWithTimeout('/tables');
      if (Array.isArray(dados) && dados.length > 0) return dados;
      throw new Error('Lista de mesas vazia.');
    } catch {
      // Só usamos as mesas de exemplo se o servidor realmente não respondeu.
      return Array.from({ length: 10 }, (_, i) => ({
        id: `t${i + 1}`,
        number: i + 1,
        name: `Mesa ${i + 1}`,
        status: 'FREE'
      }));
    }
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

  async deleteOrderItem(itemId: string) {
    return await fetchWithTimeout(`/orders/item/${itemId}`, { method: 'DELETE' });
  },

  async updateOrderItemQuantity(itemId: string, quantity: number) {
    return await fetchWithTimeout(`/orders/item/${itemId}/quantity`, {
      method: 'PATCH',
      body: JSON.stringify({ quantity })
    });
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

  async closeDailyExpedient(): Promise<any> {
    return await fetchWithTimeout('/cashier/close-expedient', { method: 'POST' }, 15000);
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
        payment_methods_allowed: ['CASH', 'CREDIT_CARD', 'DEBIT_CARD', 'PIX']
      };
    }
  },

  async updateSettings(data: Partial<RestaurantSettings>): Promise<RestaurantSettings> {
    return await fetchWithTimeout('/admin/settings', {
      method: 'PUT',
      body: JSON.stringify(data)
    });
  },

  async changeAdminCredentials(data: { currentPassword: string; newUsername: string; newPassword: string }): Promise<any> {
    return await fetchWithTimeout('/admin/change-credentials', {
      method: 'POST',
      body: JSON.stringify(data)
    });
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

  async login(username: string, password: string): Promise<any> {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Falha na autenticação.' }));
      throw new Error(err.error || 'Usuário ou senha incorretos.');
    }

    const data = await res.json();
    if (data.token) {
      activeToken = data.token;
      authPromise = null;
    }
    return data.user;
  }
};
