import Dexie from 'dexie';
import type { Table as DexieTable } from 'dexie';

export interface OfflineOrder {
  id?: number;
  offline_sync_id: string;
  table_id: string;
  table_number: number;
  items: {
    menu_item_id: string;
    quantity: number;
    notes?: string;
  }[];
  notes?: string;
  created_at: string;
  synced: number; // 0 = falso, 1 = verdadeiro
}

class RestaurantOfflineDB extends Dexie {
  offlineOrders!: DexieTable<OfflineOrder, number>;

  constructor() {
    super('RestaurantOfflineDB');
    this.version(1).stores({
      offlineOrders: '++id, offline_sync_id, table_id, synced'
    });
  }
}

let dbInstance: RestaurantOfflineDB | null = null;
try {
  dbInstance = new RestaurantOfflineDB();
} catch (e) {
  console.warn('IndexedDB Dexie não pôde ser inicializado:', e);
}

export const offlineDb = dbInstance;
