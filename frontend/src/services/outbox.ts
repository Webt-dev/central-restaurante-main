import { useSyncExternalStore } from 'react';
import { offlineDb, type OfflineOrder } from './offlineDb';
import { api, ApiError } from './api';
import { socket } from './socket';
import { getToken, subscribeSession } from './session';

/**
 * Fila de saída de pedidos do garçom.
 *
 * Todo pedido é gravado no aparelho ANTES de ir para a central, com um
 * offline_sync_id fixo. Se a rede cair no meio do envio, o reenvio usa o
 * mesmo id e a central não duplica o pedido. Os envios acontecem sozinhos:
 * logo após salvar, quando a conexão volta e a cada 15 s enquanto houver
 * pendências. Pedidos recusados pela central (ex.: falta de estoque) ficam
 * com o motivo visível para o garçom decidir.
 */

const RETRY_MS = 15_000;

let snapshot: OfflineOrder[] = [];
const listeners = new Set<() => void>();
let flushing: Promise<void> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

function emit() {
  listeners.forEach(fn => fn());
}

async function refresh(): Promise<void> {
  if (!offlineDb) return;
  snapshot = await offlineDb.offlineOrders.orderBy('id').toArray();
  emit();
}

function newSyncId(): string {
  const rand = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `off_${rand}`;
}

function scheduleRetry() {
  if (retryTimer) clearTimeout(retryTimer);
  if (snapshot.some(o => o.status === 'pending')) {
    retryTimer = setTimeout(() => void flush(), RETRY_MS);
  }
}

/** Envia todos os pendentes num lote. Seguro chamar várias vezes. */
export function flush(): Promise<void> {
  if (flushing) return flushing;
  flushing = (async () => {
    try {
      if (!offlineDb || !getToken()) return;
      const pending = await offlineDb.offlineOrders.where('status').equals('pending').toArray();
      if (pending.length === 0) return;

      let result: { syncedCount: number; errors: { offline_sync_id: string; error: string }[] };
      try {
        result = await api.syncOrders(pending.map(o => ({
          table_id: o.table_id,
          offline_sync_id: o.offline_sync_id,
          items: o.items.map(({ menu_item_id, quantity, notes }) => ({ menu_item_id, quantity, notes })),
          notes: o.notes || undefined
        })));
      } catch (err) {
        if (err instanceof ApiError && err.code === 'LICENSE_BLOCKED') {
          // Sistema bloqueado pela licença: o pedido fica guardado com o motivo à vista.
          await Promise.all(pending.map(o => offlineDb!.offlineOrders.update(o.id!, { status: 'error', error: err.message, attempts: o.attempts + 1 })));
          return;
        }
        // Sem rede ou central fora do ar: tudo continua pendente.
        await Promise.all(pending.map(o => offlineDb!.offlineOrders.update(o.id!, { attempts: o.attempts + 1 })));
        return;
      }

      const failed = new Map(result.errors.map(e => [e.offline_sync_id, e.error]));
      for (const o of pending) {
        const error = failed.get(o.offline_sync_id);
        if (error) {
          await offlineDb.offlineOrders.update(o.id!, { status: 'error', error, attempts: o.attempts + 1 });
        } else {
          // Enviado: apaga do aparelho (não guardamos pedidos já entregues à central).
          await offlineDb.offlineOrders.delete(o.id!);
        }
      }
    } finally {
      await refresh();
      scheduleRetry();
      flushing = null;
    }
  })();
  return flushing;
}

export interface NewOrder {
  table_id: string;
  table_number: number;
  table_name?: string;
  items: { menu_item_id: string; quantity: number; notes?: string; name?: string }[];
  notes?: string;
}

/**
 * Grava o pedido no aparelho e tenta enviar. Retorna 'sent' se a central
 * confirmou, 'queued' se ficou guardado para envio automático ou 'rejected'
 * (com o motivo) se a central recusou.
 */
export async function submitOrder(order: NewOrder): Promise<{ status: 'sent' | 'queued' | 'rejected'; error?: string }> {
  if (!offlineDb) {
    // Navegador sem IndexedDB: envio direto, sem fila.
    await api.createOrder(order.table_id, order.items.map(({ name, ...i }) => i), newSyncId());
    return { status: 'sent' };
  }

  const offline_sync_id = newSyncId();
  await offlineDb.offlineOrders.add({
    ...order,
    offline_sync_id,
    created_at: new Date().toISOString(),
    status: 'pending',
    attempts: 0
  });
  await refresh();
  await flush();

  const row = await offlineDb.offlineOrders.where('offline_sync_id').equals(offline_sync_id).first();
  if (!row) return { status: 'sent' };
  if (row.status === 'error') return { status: 'rejected', error: row.error };
  return { status: 'queued' };
}

export async function retryOrder(id: number): Promise<void> {
  await offlineDb?.offlineOrders.update(id, { status: 'pending', error: undefined });
  await refresh();
  await flush();
}

export async function discardOrder(id: number): Promise<void> {
  await offlineDb?.offlineOrders.delete(id);
  await refresh();
}

export function useOutbox(): OfflineOrder[] {
  return useSyncExternalStore(
    fn => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => snapshot
  );
}

// ------------------------------------------------- cache de leitura local

export async function cacheSet(key: string, value: unknown): Promise<void> {
  try {
    await offlineDb?.cache.put({ key, value, updated_at: new Date().toISOString() });
  } catch {
    // cache é só conveniência
  }
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const entry = await offlineDb?.cache.get(key);
    return (entry?.value as T) ?? null;
  } catch {
    return null;
  }
}

// --------------------------------------------------------- gatilhos de envio

socket.on('connect', () => void flush());
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => void flush());
}
subscribeSession(() => {
  if (getToken()) void flush();
});
void refresh().then(() => flush());
