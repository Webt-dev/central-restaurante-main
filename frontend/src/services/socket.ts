import { io, Socket } from 'socket.io-client';

// Conecta dinamicamente ao IP do servidor onde a aplicação está rodando na rede
const SOCKET_URL = typeof window !== 'undefined'
  ? `${window.location.protocol}//${window.location.hostname}:3000`
  : 'http://localhost:3000';

let socketInstance: Socket | null = null;

try {
  socketInstance = io(SOCKET_URL, {
    autoConnect: true,
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionAttempts: 10,
    timeout: 5000
  });
} catch (e) {
  console.warn('Socket.IO não pôde ser inicializado de imediato:', e);
}

export const socket = socketInstance;

export function joinRoom(room: 'kitchen' | 'waiter' | 'cashier') {
  if (socket && socket.connected) {
    socket.emit('join_room', room);
  }
}
