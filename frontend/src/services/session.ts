import { useSyncExternalStore } from 'react';

export type UserRole = 'ADMIN' | 'CASHIER' | 'WAITER' | 'KITCHEN';

export interface SessionUser {
  id: string;
  name: string;
  username?: string;
  role: UserRole;
}

export interface Session {
  token: string;
  user: SessionUser;
  /** Senha de fábrica ou fraca: o app exige a troca antes de liberar as telas. */
  mustChangePassword?: boolean;
}

/**
 * Sessão do aparelho. Fica no localStorage para o garçom não precisar logar
 * a cada recarga; o servidor invalida o token em 12 h, ou na hora se o
 * usuário for desativado ou trocar de senha.
 */
const STORAGE_KEY = 'cr.session';

function read(): Session | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Session;
    return parsed?.token && parsed?.user?.role ? parsed : null;
  } catch {
    return null;
  }
}

let current: Session | null = read();
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach(fn => fn());
}

export function getSession(): Session | null {
  return current;
}

export function getToken(): string | null {
  return current?.token ?? null;
}

export function setSession(session: Session): void {
  current = session;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Sem localStorage (aba anônima): a sessão vale só enquanto a página estiver aberta.
  }
  notify();
}

export function clearSession(): void {
  current = null;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
  notify();
}

export function subscribeSession(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useSession(): Session | null {
  return useSyncExternalStore(subscribeSession, getSession, getSession);
}

/** Telas que cada papel pode abrir. ADMIN vê tudo. */
export const SCREENS_BY_ROLE: Record<UserRole, string[]> = {
  ADMIN: ['/garcom', '/cozinha', '/bar', '/caixa', '/relatorios', '/admin'],
  CASHIER: ['/caixa', '/garcom', '/relatorios'],
  WAITER: ['/garcom'],
  KITCHEN: ['/cozinha', '/bar']
};

export const ROLE_LABELS: Record<UserRole, string> = {
  ADMIN: 'Administrador',
  CASHIER: 'Caixa',
  WAITER: 'Garçom',
  KITCHEN: 'Cozinha / Bar'
};

export function canAccess(role: UserRole, path: string): boolean {
  return SCREENS_BY_ROLE[role].some(p => path.startsWith(p));
}

export function homeFor(role: UserRole): string {
  return SCREENS_BY_ROLE[role][0]!;
}
