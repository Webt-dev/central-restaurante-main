import { Server as SocketIOServer, Socket } from 'socket.io';
import { Server as HTTPServer } from 'node:http';
import { resolveSession } from '../middlewares/authMiddleware.js';
import type { UserRole } from '../models/types.js';
import { env } from '../config/env.js';

export interface ConnectedDevice {
  id: string;
  ip: string;
  userAgent: string;
  deviceType: string;
  room: string;
  userName: string;
  role: UserRole;
  connectedAt: string;
}

/**
 * Salas definidas pelo papel do usuário logado — o aparelho não escolhe mais
 * em qual sala entra. ADMIN recebe tudo.
 */
const ROOMS_BY_ROLE: Record<UserRole, string[]> = {
  ADMIN: ['admin', 'kitchen', 'waiter', 'cashier'],
  CASHIER: ['cashier', 'waiter'],
  WAITER: ['waiter'],
  KITCHEN: ['kitchen']
};

const connectedDevicesMap = new Map<string, ConnectedDevice>();
let io: SocketIOServer | null = null;

function parseDeviceType(userAgent: string): string {
  const ua = userAgent.toLowerCase();
  if (ua.includes('iphone')) return 'iPhone (iOS)';
  if (ua.includes('ipad')) return 'iPad (iOS)';
  if (ua.includes('android')) {
    if (ua.includes('mobile')) return 'Smartphone Android';
    return 'Tablet Android';
  }
  if (ua.includes('windows')) return 'Computador Windows (PC)';
  if (ua.includes('macintosh') || ua.includes('mac os')) return 'Computador Mac (Apple)';
  if (ua.includes('linux')) return 'Computador Linux';
  if (ua.includes('smart-tv') || ua.includes('googletv') || ua.includes('tizen')) return 'Smart TV (KDS)';
  return 'Dispositivo Web';
}

// A lista de aparelhos (com IPs) só vai para quem administra.
function broadcastDevicesUpdate(): void {
  if (io) {
    const list = getConnectedDevices();
    io.to('admin').to('cashier').emit('devices:updated', list);
  }
}

export function getConnectedDevices(): ConnectedDevice[] {
  return Array.from(connectedDevicesMap.values());
}

export function initSocketIO(server: HTTPServer): SocketIOServer {
  io = new SocketIOServer(server, {
    // Em produção o frontend é servido pelo próprio servidor (mesma origem).
    // CORS só é liberado no desenvolvimento, para o Vite na porta 5173.
    cors: env.NODE_ENV === 'development' ? { origin: true } : undefined
  });

  // Sem token válido, a conexão é recusada.
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    const session = resolveSession(token);
    if (!session || session.mcp) return next(new Error('unauthorized'));
    socket.data.user = session;
    next();
  });

  io.on('connection', (socket: Socket) => {
    const user = socket.data.user as { userId: string; name: string; role: UserRole };
    const cleanIp = socket.handshake.address.replace('::ffff:', '').replace('::1', '127.0.0.1');
    const userAgent = socket.handshake.headers['user-agent'] || 'Desconhecido';
    const deviceType = parseDeviceType(userAgent);
    const rooms = ROOMS_BY_ROLE[user.role] ?? [];

    rooms.forEach(room => socket.join(room));
    socket.join(`user:${user.userId}`);

    connectedDevicesMap.set(socket.id, {
      id: socket.id,
      ip: cleanIp,
      userAgent,
      deviceType,
      room: rooms.join(', '),
      userName: user.name,
      role: user.role,
      connectedAt: new Date().toISOString()
    });
    broadcastDevicesUpdate();

    socket.on('disconnect', () => {
      connectedDevicesMap.delete(socket.id);
      broadcastDevicesUpdate();
    });
  });

  return io;
}

/** Derruba as conexões em tempo real de um usuário (desativado, senha trocada). */
export function disconnectUser(userId: string): void {
  io?.in(`user:${userId}`).disconnectSockets(true);
}

export function getIO(): SocketIOServer {
  if (!io) {
    throw new Error('Socket.IO não foi inicializado!');
  }
  return io;
}

export function emitEvent(event: string, data?: any): void {
  if (io) {
    io.emit(event, data);
  }
}

// Métodos utilitários para disparo de eventos em tempo real
export function notifyOrderCreated(order: any): void {
  if (io) {
    io.to('kitchen').emit('order:created', order);
    io.to('cashier').emit('order:created', order);
  }
}

export function notifyOrderStatusChanged(order: any): void {
  if (io) {
    io.to('kitchen').emit('order:status_changed', order);
    io.to('waiter').emit('order:status_changed', order);
    io.to('cashier').emit('order:status_changed', order);
  }
}

export function notifyTableStatusChanged(table: any): void {
  if (io) {
    io.to('waiter').emit('table:status_changed', table);
    io.to('cashier').emit('table:status_changed', table);
  }
}

export function notifyPaymentProcessed(payment: any): void {
  if (io) {
    io.to('cashier').emit('payment:processed', payment);
    io.to('waiter').emit('payment:processed', payment);
  }
}
