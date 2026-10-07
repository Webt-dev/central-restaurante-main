/**
 * Dinheiro em centavos inteiros.
 *
 * Somar valores em ponto flutuante (0.1 + 0.2 = 0.30000000000000004)
 * acumula erro em totais de caixa e de conta. Toda conta de dinheiro do
 * backend é feita em centavos (inteiros) e só vira reais na hora de gravar
 * ou responder. As colunas do banco continuam em reais com 2 casas.
 */
export type Cents = number;

export function toCents(reais: number | string | null | undefined): Cents {
  const n = Number(reais);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

export function toReais(cents: Cents): number {
  return Math.round(cents) / 100;
}

/** Soma valores em reais sem erro de arredondamento. */
export function sumReais(values: (number | null | undefined)[]): number {
  return toReais(values.reduce<number>((acc, v) => acc + toCents(v ?? 0), 0));
}

/** Multiplica um preço em reais por uma quantidade, arredondando ao centavo. */
export function lineTotal(unitPrice: number, quantity: number): number {
  return toReais(toCents(unitPrice) * quantity);
}

/** Percentual sobre um valor em reais (ex.: taxa de serviço), arredondado ao centavo. */
export function percentOf(reais: number, percent: number): number {
  return toReais(Math.round((toCents(reais) * percent) / 100));
}
