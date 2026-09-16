import { Server as SocketIOServer, Socket } from 'socket.io';
import { Server as HTTPServer } from 'node:http';

export interface ConnectedDevice {
  id: string;
  ip: string;
  userAgent: string;
  deviceType: string;
  room: string;
  connectedAt: string;
}

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

function broadcastDevicesUpdate(): void {
  if (io) {
    const list = getConnectedDevices();
    io.emit('devices:updated', list);
  }
}

export function getConnectedDevices(): ConnectedDevice[] {
  return Array.from(connectedDevicesMap.values());
}

export function initSocketIO(server: HTTPServer): SocketIOServer {
  io = new SocketIOServer(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST', 'PUT', 'DELETE']
    }
  });

  io.on('connection', (socket: Socket) => {
    const rawIp = (socket.handshake.headers['x-forwarded-for'] as string) || socket.handshake.address;
    const cleanIp = rawIp.replace('::ffff:', '').replace('::1', '127.0.0.1');
    const userAgent = socket.handshake.headers['user-agent'] || 'Desconhecido';
    const deviceType = parseDeviceType(userAgent);

    const deviceObj: ConnectedDevice = {
      id: socket.id,
      ip: cleanIp,
      userAgent,
      deviceType,
      room: 'Geral',
      connectedAt: new Date().toISOString()
    };

    connectedDevicesMap.set(socket.id, deviceObj);
    console.log(`🔌 Novo dispositivo conectado [${deviceType}] IP: ${cleanIp} (ID: ${socket.id})`);
    broadcastDevicesUpdate();

    socket.on('join_room', (room: string) => {
      socket.join(room);
      const existing = connectedDevicesMap.get(socket.id);
      if (existing) {
        existing.room = room;
        connectedDevicesMap.set(socket.id, existing);
      }
      console.log(`📌 Dispositivo ${socket.id} (${deviceType}) entrou na sala: ${room}`);
      broadcastDevicesUpdate();
    });

    socket.on('disconnect', () => {
      connectedDevicesMap.delete(socket.id);
      console.log(`🔌 Dispositivo desconectado: ${socket.id}`);
      broadcastDevicesUpdate();
    });
  });

  return io;
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
