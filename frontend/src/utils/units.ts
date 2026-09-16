/**
 * Padronização de unidades e nomes do estoque.
 *
 * O banco continua guardando gramas e mililitros (a ficha técnica precisa dessa
 * precisão para abater 180 g de carne por lanche). Aqui só convertemos para
 * exibição, para o gerente ver "4,87 kg" em vez de "4870 g".
 */

export interface InventoryLike {
  name: string;
  unit: string;
  quantity: number;
  min_quantity: number;
}

/** Remove sufixos redundantes do nome: "Bacon Defumado Fatiado (Grama)" -> "Bacon Defumado Fatiado". */
export function cleanInventoryName(name: string): string {
  return String(name || '')
    .replace(/\s*\((grama|gramas|g|unidade|unidades|un|dose\s*50ml|dose|ml|litro|litros|l|pacote|pct)\)\s*$/i, '')
    .trim();
}

/** Nome curto e legível da unidade, no singular. */
export function unitLabel(unit: string): string {
  const u = String(unit || '').toLowerCase();
  const map: Record<string, string> = {
    g: 'g',
    kg: 'kg',
    ml: 'ml',
    l: 'L',
    litro: 'L',
    un: 'un',
    unidade: 'un',
    dose: 'doses',
    pct: 'pacotes'
  };
  return map[u] || unit;
}

/**
 * Converte para a unidade mais legível.
 * 4870 g -> "4,87 kg" | 850 g -> "850 g" | 2500 ml -> "2,5 L" | 79 dose -> "79 doses"
 */
export function formatQuantity(quantity: number, unit: string): string {
  const qty = Number(quantity) || 0;
  const u = String(unit || '').toLowerCase();

  if (u === 'g' && Math.abs(qty) >= 1000) {
    return `${formatNumber(qty / 1000)} kg`;
  }
  if (u === 'ml' && Math.abs(qty) >= 1000) {
    return `${formatNumber(qty / 1000)} L`;
  }
  return `${formatNumber(qty)} ${unitLabel(u)}`;
}

/** Número no padrão brasileiro, sem casas decimais desnecessárias. */
export function formatNumber(value: number): string {
  const n = Number(value) || 0;
  if (Number.isInteger(n)) return n.toLocaleString('pt-BR');
  return n.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 2 });
}

export type StockLevel = 'CRITICAL' | 'LOW' | 'OK';

export interface StockHealth {
  /** 0 a 100, para a largura da barra. */
  percent: number;
  level: StockLevel;
  label: string;
  color: string;
  /** Quantas vezes o estoque mínimo o item possui. */
  ratio: number;
}

/**
 * Saúde do estoque em escala logarítmica sobre a razão quantidade/mínimo.
 *
 * A versão anterior usava quantity / (min * 3), o que saturava em 100% para
 * quase todos os insumos. Agora a barra só enche perto de 10x o mínimo e
 * desce de forma perceptível conforme o insumo é consumido.
 */
export function getStockHealth(quantity: number, minQuantity: number): StockHealth {
  const qty = Math.max(0, Number(quantity) || 0);
  const min = Number(minQuantity) || 0;

  if (min <= 0) {
    const flat = qty > 0 ? 100 : 0;
    return {
      percent: flat,
      level: qty > 0 ? 'OK' : 'CRITICAL',
      label: qty > 0 ? 'Sem mínimo definido' : 'Sem estoque',
      color: qty > 0 ? 'var(--green)' : 'var(--red)',
      ratio: 0
    };
  }

  const ratio = qty / min;
  // Escala log: cheia (100%) somente a 10x o mínimo; no mínimo exato fica ~29%.
  const percent = Math.max(0, Math.min(100, (Math.log(1 + ratio) / Math.log(11)) * 100));

  if (ratio <= 1) {
    return { percent, level: 'CRITICAL', label: 'Repor agora', color: 'var(--red)', ratio };
  }
  if (ratio <= 2) {
    return { percent, level: 'LOW', label: 'Acabando', color: 'var(--amber)', ratio };
  }
  return { percent, level: 'OK', label: 'Adequado', color: 'var(--green)', ratio };
}

/** Opções de unidade oferecidas no cadastro de insumos. */
export const UNIT_OPTIONS: { value: string; label: string; hint: string }[] = [
  { value: 'g', label: 'Peso em gramas (g)', hint: 'Carnes, queijos, batata. Aparece em kg quando passa de 1000 g.' },
  { value: 'ml', label: 'Volume em mililitros (ml)', hint: 'Molhos e líquidos. Aparece em litros quando passa de 1000 ml.' },
  { value: 'un', label: 'Unidades (un)', hint: 'Pães, latas, ovos, sobremesas prontas.' },
  { value: 'dose', label: 'Doses (dose)', hint: 'Bebidas destiladas porcionadas, normalmente 50 ml.' },
  { value: 'pct', label: 'Pacotes (pct)', hint: 'Itens comprados fechados por pacote.' }
];
