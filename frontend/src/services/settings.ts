import { useEffect, useState } from 'react';
import { api } from './api';
import { socket } from './socket';
import type { RestaurantSettings } from '../types';

/**
 * Fonte única da verdade para a taxa de serviço (gorjeta) no frontend.
 *
 * Antes o valor de 10% estava fixo no código de várias telas, o que fazia
 * a configuração do painel administrativo não surtir efeito. Agora todas as
 * telas leem o percentual configurado em Gestão > Configurações.
 */

const DEFAULT_SETTINGS: RestaurantSettings = {
  restaurant_name: 'Central Restaurante',
  cnpj: '',
  phone: '',
  address: '',
  service_tax_percent: 10,
  payment_methods_allowed: ['CASH', 'CREDIT_CARD', 'DEBIT_CARD', 'PIX']
};

let cache: RestaurantSettings = DEFAULT_SETTINGS;
let inflight: Promise<RestaurantSettings> | null = null;
const listeners = new Set<(s: RestaurantSettings) => void>();

function notify(next: RestaurantSettings) {
  cache = next;
  listeners.forEach(fn => fn(next));
}

export function getCachedSettings(): RestaurantSettings {
  return cache;
}

export async function loadSettings(force = false): Promise<RestaurantSettings> {
  if (!force && inflight) return inflight;
  inflight = api
    .getSettings()
    .then(data => {
      const merged: RestaurantSettings = {
        ...DEFAULT_SETTINGS,
        ...data,
        service_tax_percent: normalizePercent(data?.service_tax_percent)
      };
      notify(merged);
      return merged;
    })
    .catch(() => cache)
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function normalizePercent(value: unknown): number {
  const n = Number(value);
  if (!isFinite(n) || n < 0) return 0;
  return Math.min(100, n);
}

/** Hook React: retorna as configurações e se mantém atualizado via WebSocket. */
export function useSettings(): RestaurantSettings {
  const [settings, setSettings] = useState<RestaurantSettings>(cache);

  useEffect(() => {
    const listener = (s: RestaurantSettings) => setSettings(s);
    listeners.add(listener);
    loadSettings();

    const onUpdated = () => loadSettings(true);
    if (socket) socket.on('settings:updated', onUpdated);

    return () => {
      listeners.delete(listener);
      if (socket) socket.off('settings:updated', onUpdated);
    };
  }, []);

  return settings;
}

/** Percentual da taxa de serviço configurado (0 = desativada). */
export function useServiceTaxPercent(): number {
  return normalizePercent(useSettings().service_tax_percent);
}

/** Calcula o valor da taxa de serviço sobre um subtotal. */
export function calcServiceTax(subtotal: number, percent: number): number {
  const pct = normalizePercent(percent);
  if (pct <= 0) return 0;
  return Number(((subtotal * pct) / 100).toFixed(2));
}

/** Formata o percentual para exibição (10, 12.5, 0...). */
export function formatPercent(percent: number): string {
  const pct = normalizePercent(percent);
  return Number.isInteger(pct) ? String(pct) : String(pct).replace('.', ',');
}

export function formatBRL(value: number): string {
  return `R$ ${(Number(value) || 0).toFixed(2)}`;
}
