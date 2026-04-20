import { Server } from 'socket.io';
import { verifyToken } from './jwt';
import { redis, redisSub } from './redis';

let io: Server;

export function initSocketIO(httpServer: any) {
  io = new Server(httpServer, {
    cors: { origin: '*', credentials: true },
    path: '/socket.io',
  });

  // Auth middleware
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.replace('Bearer ', '');
    if (!token) return next(new Error('Authentication required'));
    try {
      const user = await verifyToken(token);
      socket.data.user = user;
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    const user = socket.data.user;

    // Auto-join rooms
    if (user.tenantId) socket.join(`tenant:${user.tenantId}`);
    socket.join(`user:${user.sub}`);

    // Agent status
    socket.on('agent:status', async (status: string) => {
      await redis.hset('treepbx:agents:online', user.sub, JSON.stringify({ status, tenantId: user.tenantId, updatedAt: Date.now() }));
      if (user.tenantId) io.to(`tenant:${user.tenantId}`).emit('agent:status_changed', { agentId: user.sub, status });
    });

    socket.on('disconnect', async () => {
      await redis.hdel('treepbx:agents:online', user.sub);
      if (user.tenantId) io.to(`tenant:${user.tenantId}`).emit('agent:status_changed', { agentId: user.sub, status: 'offline' });
    });
  });

  // Redis pub/sub for cross-process events
  redisSub.subscribe('treepbx:events');
  redisSub.on('message', (channel, message) => {
    try {
      const { room, event, data } = JSON.parse(message);
      if (room) io.to(room).emit(event, data);
      else io.emit(event, data);
    } catch {}
  });

  return io;
}

export function getIO(): Server { return io; }
export function emitToTenant(tenantId: string, event: string, data: unknown) { io?.to(`tenant:${tenantId}`).emit(event, data); }
export function emitToUser(userId: string, event: string, data: unknown) { io?.to(`user:${userId}`).emit(event, data); }
