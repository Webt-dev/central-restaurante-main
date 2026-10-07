import Dexie from 'dexie';
import type { Table as DexieTable } from 'dexie';

export type OutboxStatus = 'pending' | 'error';

export interface OfflineOrder {
  id?: number;
  offline_sync_id: string;
  table_id: string;
  table_number: number;
  table_name?: string;
  items: {
    menu_item_id: string;
    quantity: number;
    notes?: string;
    name?: string;
  }[];
  notes?: string;
  created_at: string;
  /** pending = aguardando envio; error = a central recusou (ex.: estoque). */
  status: OutboxStatus;
  error?: string;
  attempts: number;
  /** Mantido por compatibilidade com a versão 1 do banco local. */
  synced?: number;
}

export interface CacheEntry {
  key: string;
  value: unknown;
  updated_at: string;
}

class RestaurantOfflineDB extends Dexie {
  offlineOrders!: DexieTable<OfflineOrder, number>;
  cache!: DexieTable<CacheEntry, string>;

  constructor() {
    super('RestaurantOfflineDB');
    this.version(1).stores({
      offlineOrders: '++id, offline_sync_id, table_id, synced'
    });
    // v2: fila de saída com status/erro e cache de cardápio e mesas.
    this.version(2)
      .stores({
        offlineOrders: '++id, &offline_sync_id, table_id, status',
        cache: 'key'
      })
      .upgrade(async tx => {
        const orders = tx.table('offlineOrders');
        // Pedidos já sincronizados não precisam ficar no aparelho (LGPD).
        await orders.filter((o: OfflineOrder) => o.synced === 1).delete();
        await orders.toCollection().modify((o: OfflineOrder) => {
          o.status = 'pending';
          o.attempts = 0;
          delete o.synced;
        });
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
