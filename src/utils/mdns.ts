import { Bonjour } from 'bonjour-service';
import os from 'node:os';

let instance: Bonjour | null = null;

export function initMDNS(frontendPort = 5173, backendPort = 3000): void {
  const hostname = os.hostname();

  try {
    instance = new Bonjour();

    // Publica o serviço mDNS para o nome restaurante.local na rede Wi-Fi local
    instance.publish({
      name: 'restaurante',
      type: 'http',
      port: frontendPort,
      host: 'restaurante.local'
    });

    instance.publish({
      name: 'restaurante-api',
      type: 'http',
      port: backendPort,
      host: 'restaurante.local'
    });

    console.log('🌐 Servidor DNS Local (mDNS / Bonjour) Ativo na Rede Wi-Fi:');
    console.log(`   📱 Opção 1 (DNS mDNS):      http://restaurante.local:${frontendPort}`);
    console.log(`   💻 Opção 2 (Host Nativo):   http://${hostname.toLowerCase()}.local:${frontendPort}`);
    console.log(`   💡 DICA IMPORTANTE NO CELULAR: Digite sempre "http://" antes do endereço no navegador do celular!`);
  } catch (err) {
    console.warn('⚠️ Não foi possível registrar o serviço mDNS no sistema:', err);
  }
}

export function stopMDNS(): void {
  if (instance) {
    instance.destroy();
  }
}
