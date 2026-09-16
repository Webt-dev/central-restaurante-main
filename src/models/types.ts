export type UserRole = 'ADMIN' | 'CASHIER' | 'WAITER' | 'KITCHEN';

export interface User {
  id: string;
  name: string;
  username: string;
  role: UserRole;
  password_hash: string;
  created_at: string;
}

export interface InventoryItem {
  id: string;
  name: string;
  unit: string; // e.g. 'kg', 'un', 'litro', 'g'
  quantity: number;
  min_quantity: number;
  unit_price: number;
  created_at: string;
  updated_at: string;
}

export interface MenuItem {
  id: string;
  name: string;
  description: string;
  price: number;
  category: string;
  active: boolean;
  ingredients?: MenuItemIngredientDetail[];
  created_at: string;
}

export interface MenuItemIngredient {
  id: string;
  menu_item_id: string;
  inventory_id: string;
  quantity_required: number;
}

export interface MenuItemIngredientDetail extends MenuItemIngredient {
  ingredient_name: string;
  unit: string;
  available_quantity: number;
}

export type TableStatus = 'FREE' | 'OCCUPIED' | 'PAYMENT_PENDING';

export interface Table {
  id: string;
  number: number;
  name: string;
  status: TableStatus;
  created_at: string;
  updated_at: string;
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
  created_at: string;
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
  offline_sync_id?: string;
  cashier_session_id?: string;
  items?: OrderItem[];
  created_at: string;
  updated_at: string;
}

export type PaymentMethod = 'CASH' | 'CREDIT_CARD' | 'DEBIT_CARD' | 'PIX';

export interface Payment {
  id: string;
  table_id: string;
  order_id: string;
  cashier_session_id: string;
  payment_method: PaymentMethod;
  amount: number;
  amount_paid: number;
  change_given: number;
  created_at: string;
}

export interface CashRegisterSession {
  id: string;
  opened_by_id: string;
  opened_by_name?: string;
  closed_by_id?: string;
  closed_by_name?: string;
  opened_at: string;
  closed_at?: string;
  initial_balance: number;
  final_balance?: number;
  total_sales: number;
  total_cash: number;
  total_card: number;
  total_pix: number;
  status: 'OPEN' | 'CLOSED';
}

export interface TableBillSummary {
  table: Table;
  orders: Order[];
  total_amount: number;
  items_summary: {
    menu_item_id: string;
    name: string;
    quantity: number;
    unit_price: number;
    total_price: number;
  }[];
}

export interface DailyReport {
  date: string;
  cashier_session: CashRegisterSession | null;
  total_sales: number; // Faturamento Total Geral (Bruto Consumo + 10%)
  total_sales_subtotal: number; // Total Só sem os 10% (Consumo Pratos e Bebidas)
  total_sales_tips: number; // Total Só 10% (Arrecadação de Taxas de Serviço do Garçom)
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
      method: PaymentMethod;
      amount: number;
    }[];
  }[];
  inventory_alerts: InventoryItem[];
}
