import type { ThemePreference } from '../types';

/**
 * Aplica o tema escolhido pelo ADMIN (Claro, Escuro ou Usar cores do
 * sistema) e guarda a última escolha neste aparelho, para a próxima abertura
 * já pintar com o tema certo mesmo sem conexão (ver script em index.html).
 */
const STORAGE_KEY = 'cr.theme';
const VALID: ThemePreference[] = ['light', 'dark', 'system'];

export function applyTheme(pref: ThemePreference | undefined): void {
  const theme = pref && VALID.includes(pref) ? pref : 'system';
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // sem armazenamento: aplica só nesta sessão
  }
}

/* =========================================================================
   MODO LEVE (desempenho)
   Aparelhos fracos (celular antigo, notebook simples) ficam mais fluidos sem
   animações e sombras. Cores, cantos e fontes continuam iguais.
   - 'auto' : liga sozinho se o aparelho for fraco (pouca memória/CPU) ou se o
              usuário pediu menos movimento no sistema.
   - 'full' : sempre completo.
   - 'lite' : sempre leve.
   A escolha é feita pelo ADMIN (Gestão → Configurações → Aparência).
   ========================================================================= */
export type PerfPreference = 'auto' | 'full' | 'lite';
const PERF_KEY = 'cr.perf';
const PERF_VALID: PerfPreference[] = ['auto', 'full', 'lite'];

export function getStoredPerf(): PerfPreference {
  try {
    const v = localStorage.getItem(PERF_KEY) as PerfPreference | null;
    if (v && PERF_VALID.includes(v)) return v;
  } catch {
    // sem armazenamento: usa o automático
  }
  return 'auto';
}

/** Decide se o aparelho é "fraco". Mesma regra do script de index.html (primeira pintura). */
export function isLowEndDevice(): boolean {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const lowMem = typeof nav.deviceMemory === 'number' && nav.deviceMemory <= 4;
  const lowCpu = typeof nav.hardwareConcurrency === 'number' && nav.hardwareConcurrency <= 2;
  const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  return lowMem || lowCpu || reduced;
}

export function applyPerf(pref: PerfPreference | undefined): void {
  const p = pref && PERF_VALID.includes(pref) ? pref : 'auto';
  const lite = p === 'lite' || (p === 'auto' && isLowEndDevice());
  if (lite) document.documentElement.setAttribute('data-perf', 'lite');
  else document.documentElement.removeAttribute('data-perf');
  try {
    localStorage.setItem(PERF_KEY, p);
  } catch {
    // sem armazenamento: vale só nesta sessão
  }
}

/* =========================================================================
   MARCA DO CLIENTE (white-label) — preparado, ainda sem endpoint
   Quando existir GET /api/tenant (em src/, ainda não implementado), basta
   chamar applyTenant(resposta). Só tokens de marca permitidos são aplicados e
   a cor só vale se o texto sobre ela (--on-accent) tiver contraste AA (4,5:1).
   ========================================================================= */
export interface TenantBranding {
  brand?: string;      // cor principal, #RRGGBB
  brandHover?: string; // cor ao passar o mouse; se faltar, é derivada da principal
}

type RGB = [number, number, number];

function parseHex(hex: string | undefined): RGB | null {
  const m = /^#([0-9a-f]{6})$/i.exec((hex || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance([r, g, b]: RGB): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** Razão de contraste WCAG entre duas cores (1 a 21). */
export function contrastRatio(a: RGB, b: RGB): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

function toHex(c: RGB): string {
  return '#' + c.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}

/** Aplica a marca do cliente. Devolve false (e não muda nada) se a cor for inválida ou ilegível. */
export function applyTenant(tenant: TenantBranding | null | undefined): boolean {
  const root = document.documentElement;
  const brand = parseHex(tenant?.brand);
  if (!brand) return false;
  const onAccent = parseHex(getComputedStyle(root).getPropertyValue('--on-accent'));
  // Se não der para ler o tema atual, assume o texto branco do tema claro.
  if (contrastRatio(brand, onAccent ?? [255, 255, 255]) < 4.5) return false;
  const hover = parseHex(tenant?.brandHover) ?? (brand.map(v => v * 0.82) as RGB);
  root.style.setProperty('--brand', toHex(brand));
  root.style.setProperty('--brand-hover', toHex(hover));
  return true;
}
