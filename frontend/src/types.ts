export type TableStatus = 'FREE' | 'OCCUPIED' | 'PAYMENT_PENDING';

export interface Table {
  id: string;
  number: number;
  name: string;
  status: TableStatus;
}

export interface MenuItem {
  id: string;
  name: string;
  description: string;
  price: number;
  category: string;
  active: boolean;
}

export type OrderStatus = 'OPEN' | 'PREPARING' | 'READY' | 'DELIVERED' | 'CLOSED' | 'CANCELLED';
export type OrderItemStatus = 'PENDING' | 'PREPARING' | 'READY' | 'DELIVERED' | 'CANCELLED';

export interface OrderItem {
  id: string;
  order_id: string;
  menu_item_id: string;
  menu_item_name?: string;
  quantity: number;
  unit_price: number;
  total_price: number;
  notes?: string;
  status: OrderItemStatus;
}

export interface Order {
  id: string;
  table_id: string;
  table_number?: number;
  waiter_id: string;
  waiter_name?: string;
  status: OrderStatus;
  total_amount: number;
  notes?: string;
  items?: OrderItem[];
  created_at: string;
}

export interface InventoryItem {
  id: string;
  name: string;
  unit: string;
  quantity: number;
  min_quantity: number;
  unit_price: number;
}

export interface CashSession {
  id: string;
  opened_at: string;
  initial_balance: number;
  total_sales: number;
  total_cash: number;
  total_card: number;
  total_pix: number;
  status: 'OPEN' | 'CLOSED';
}

export interface DailyReport {
  date: string;
  cashier_session: CashSession | null;
  total_sales: number; // Faturamento Total Geral (Bruto Consumo + 10%)
  total_sales_subtotal: number; // Total Só sem os 10% (Consumo de Pratos e Bebidas)
  total_sales_tips: number; // Total Só 10% (Taxa de Serviço dos Garçons)
  total_orders_closed: number;
  by_payment_method: {
    CASH: number;
    CREDIT_CARD: number;
    DEBIT_CARD: number;
    PIX: number;
  };
  table_orders_detail: {
    table_number: number;
    order_id: string;
    waiter_name: string;
    total_amount: number;
    closed_at: string;
    items: {
      name: string;
      quantity: number;
      unit_price: number;
      total_price: number;
    }[];
    payments: {
      method: string;
      amount: number;
    }[];
  }[];
  inventory_alerts: InventoryItem[];
}

export interface ConnectedDevice {
  id: string;
  ip: string;
  userAgent: string;
  deviceType: string;
  room: string;
  connectedAt: string;
}

export interface SystemInfo {
  local_ip: string;
  frontend_url: string;
  backend_url: string;
  connected_devices: ConnectedDevice[];
  total_connected: number;
}

export interface RestaurantSettings {
  restaurant_name: string;
  cnpj: string;
  phone: string;
  address: string;
  service_tax_percent: number;
  payment_methods_allowed: string[];
}
