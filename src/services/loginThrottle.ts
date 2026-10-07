/**
 * Limite de tentativas de login, em memória.
 *
 * Bloqueia por usuário+IP após 5 erros seguidos e por IP após 20, com espera
 * que dobra a cada novo bloqueio (1 min, 2 min, 4 min... até 15 min).
 */
const MAX_FAILS_PER_ACCOUNT = 5;
const MAX_FAILS_PER_IP = 20;
const BASE_LOCK_MS = 60_000;
const MAX_LOCK_MS = 15 * 60_000;

interface Counter {
  fails: number;
  lockedUntil: number;
  lockCount: number;
}

const counters = new Map<string, Counter>();

function get(key: string): Counter {
  let c = counters.get(key);
  if (!c) {
    c = { fails: 0, lockedUntil: 0, lockCount: 0 };
    counters.set(key, c);
  }
  return c;
}

function keys(ip: string, username: string): [string, string] {
  return [`acct:${ip}:${username.toLowerCase()}`, `ip:${ip}`];
}

/** Segundos que faltam para liberar, ou 0 se pode tentar. */
export function lockedForSeconds(ip: string, username: string): number {
  const now = Date.now();
  const wait = Math.max(...keys(ip, username).map(k => get(k).lockedUntil - now));
  return wait > 0 ? Math.ceil(wait / 1000) : 0;
}

export function registerFailure(ip: string, username: string): void {
  const [acct, ipKey] = keys(ip, username);
  for (const [key, max] of [[acct, MAX_FAILS_PER_ACCOUNT], [ipKey, MAX_FAILS_PER_IP]] as const) {
    const c = get(key);
    c.fails++;
    if (c.fails >= max) {
      c.lockedUntil = Date.now() + Math.min(BASE_LOCK_MS * 2 ** c.lockCount, MAX_LOCK_MS);
      c.lockCount++;
      c.fails = 0;
    }
  }
}

export function registerSuccess(ip: string, username: string): void {
  counters.delete(keys(ip, username)[0]);
}

/** Só para testes. */
export function resetThrottle(): void {
  counters.clear();
}
