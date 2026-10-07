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
