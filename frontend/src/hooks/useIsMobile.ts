import { useEffect, useState } from 'react';

/**
 * Informa se a tela está em tamanho de celular.
 *
 * Usado para trocar a ESTRUTURA da tela (não só o estilo): no computador o
 * garçom vê mesas, cardápio e comanda ao mesmo tempo; no celular isso vira
 * três etapas, para não exigir rolagem longa durante o atendimento.
 */
export function useIsMobile(breakpoint = 900): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(() =>
    typeof window !== 'undefined' ? window.innerWidth <= breakpoint : false
  );

  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${breakpoint}px)`);
    const onChange = (e: MediaQueryListEvent | MediaQueryList) => setIsMobile(e.matches);

    onChange(mql);

    // Safari antigo usa addListener
    if (mql.addEventListener) {
      mql.addEventListener('change', onChange as (e: MediaQueryListEvent) => void);
      return () => mql.removeEventListener('change', onChange as (e: MediaQueryListEvent) => void);
    }
    mql.addListener(onChange as any);
    return () => mql.removeListener(onChange as any);
  }, [breakpoint]);

  return isMobile;
}
