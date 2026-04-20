import type { ServerWebSocket } from 'bun';
import { authenticateWs } from './auth';
import { joinRoom, leaveAllRooms, type WsData } from './rooms';
import { handleMessage } from './handlers';
import { logger } from '../lib/logger';
import { setAgentOnline, setAgentOffline } from '../lib/redis';
import { db } from '../db/client';
import { users, chatChannelMembers, dmConversations } from '../db/schema';
import { eq, or } from 'drizzle-orm';
import { publishAgentStatus } from './publisher';

export const wsHandler = {
  async open(ws: ServerWebSocket<WsData>) {
    const { user } = ws.data;
    logger.info({ userId: user.sub, role: user.role }, 'WS connected');

    // Track agent presence in Redis
    await setAgentOnline(user.sub, { status: 'online', role: user.role, tenantId: user.tenantId, connectedAt: Date.now() });

    // Set agent status to available in DB
    await db.update(users).set({ status: 'available', statusChangedAt: new Date() }).where(eq(users.id, user.sub));
    if (user.tenantId) publishAgentStatus(user.tenantId, user.sub, 'available');

    // Auto-join rooms based on role
    if (user.tenantId) {
      joinRoom(ws, `tenant:${user.tenantId}`);
    }
    joinRoom(ws, `agent:${user.sub}`);

    // Auto-join chat channel rooms
    try {
      const memberships = await db.select({ channelId: chatChannelMembers.channelId })
        .from(chatChannelMembers).where(eq(chatChannelMembers.userId, user.sub));
      for (const m of memberships) {
        joinRoom(ws, `chat:${m.channelId}`);
      }
      logger.info({ userId: user.sub, chatRooms: memberships.length }, 'Joined chat rooms');
    } catch (err) { logger.warn({ err }, 'Failed to auto-join chat rooms'); }

    // Auto-join DM conversation rooms
    try {
      const convs = await db.select({ id: dmConversations.id })
        .from(dmConversations)
        .where(or(eq(dmConversations.userA, user.sub), eq(dmConversations.userB, user.sub)));
      for (const conv of convs) {
        joinRoom(ws, `dm:${conv.id}`);
      }
    } catch (err) { logger.warn({ err }, 'Failed to auto-join DM rooms'); }

    ws.send(JSON.stringify({ event: 'connected', data: { userId: user.sub } }));
  },

  message(ws: ServerWebSocket<WsData>, message: string | Buffer) {
    const raw = typeof message === 'string' ? message : message.toString();
    handleMessage(ws, raw);
  },

  async close(ws: ServerWebSocket<WsData>) {
    const { user } = ws.data;
    logger.info({ userId: user.sub }, 'WS disconnected');
    await setAgentOffline(user.sub);
    leaveAllRooms(ws);

    // Set agent status to offline in DB
    await db.update(users).set({ status: 'offline', statusChangedAt: new Date() }).where(eq(users.id, user.sub));
    if (user.tenantId) publishAgentStatus(user.tenantId, user.sub, 'offline');
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
