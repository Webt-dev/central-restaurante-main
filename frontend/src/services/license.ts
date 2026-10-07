import { useEffect, useState } from 'react';
import { api, type LicenseStatus } from './api';
import { socket } from './socket';

/**
 * Situação da licença para as telas (faixa de aviso e aba Licença).
 * Atualiza quando a central avisa (license:updated) e a cada 5 minutos,
 * para a contagem de dias virar sozinha mesmo com a tela aberta.
 */
export function useLicense(): [LicenseStatus | null, () => Promise<void>] {
  const [status, setStatus] = useState<LicenseStatus | null>(null);

  async function load() {
    try {
      setStatus(await api.getLicenseStatus());
    } catch {
      // sem licença carregada, a faixa simplesmente não aparece
    }
  }

  useEffect(() => {
    load();
    socket.on('license:updated', load);
    const timer = setInterval(load, 5 * 60 * 1000);
    return () => {
      socket.off('license:updated', load);
      clearInterval(timer);
    };
  }, []);

  return [status, load];
}
