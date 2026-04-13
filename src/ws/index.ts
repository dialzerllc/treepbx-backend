import type { ServerWebSocket } from 'bun';
import { authenticateWs } from './auth';
import { joinRoom, leaveAllRooms, type WsData } from './rooms';
import { handleMessage } from './handlers';
import { logger } from '../lib/logger';

export const wsHandler = {
  async open(ws: ServerWebSocket<WsData>) {
    const { user } = ws.data;
    logger.info({ userId: user.sub, role: user.role }, 'WS connected');

    // Auto-join rooms based on role
    if (user.tenantId) {
      joinRoom(ws, `tenant:${user.tenantId}`);
    }
    joinRoom(ws, `agent:${user.sub}`);

    ws.send(JSON.stringify({ event: 'connected', data: { userId: user.sub } }));
  },

  message(ws: ServerWebSocket<WsData>, message: string | Buffer) {
    const raw = typeof message === 'string' ? message : message.toString();
    handleMessage(ws, raw);
  },

  close(ws: ServerWebSocket<WsData>) {
    logger.info({ userId: ws.data.user.sub }, 'WS disconnected');
    leaveAllRooms(ws);
  },
};

export async function upgradeWebSocket(req: Request, server: any): Promise<Response | undefined> {
  const user = await authenticateWs(req.url);
  if (!user) {
    return new Response('Unauthorized', { status: 401 });
  }

  const upgraded = server.upgrade(req, {
    data: { user, rooms: new Set() } satisfies WsData,
  });

  if (!upgraded) {
    return new Response('WebSocket upgrade failed', { status: 500 });
  }

  return undefined;
}
