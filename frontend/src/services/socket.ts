import { io, Socket } from 'socket.io-client';
import { getToken, subscribeSession } from './session';

/**
 * Conexão em tempo real com a central.
 *
 * - Mesma origem da página: funciona servido pela central (porta 3000) e no
 *   Vite (proxy de /socket.io).
 * - Só conecta com usuário logado; o servidor define as salas pelo papel.
 * - Reconecta para sempre (antes desistia após 10 tentativas e o aparelho
 *   ficava "surdo" até recarregar a página).
 */
export const socket: Socket = io({
  autoConnect: false,
  reconnection: true,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 10000,
  timeout: 5000,
  auth: cb => cb({ token: getToken() })
});

function sync() {
  if (getToken()) {
    if (!socket.connected) socket.connect();
  } else if (socket.connected || socket.active) {
    socket.disconnect();
  }
}

// Token recusado pelo servidor (expirado/desativado): não fica tentando em loop.
socket.on('connect_error', err => {
  if (err.message === 'unauthorized') socket.disconnect();
});

subscribeSession(() => {
  // Troca de usuário: reconecta com o token novo.
  socket.disconnect();
  sync();
});

sync();
