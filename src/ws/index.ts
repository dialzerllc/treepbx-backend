import type { ServerWebSocket } from 'bun';
import { authenticateWs } from './auth';
import { joinRoom, leaveAllRooms, type WsData, type AnyWsData } from './rooms';
import { handleMessage } from './handlers';
import { terminalOpen, terminalMessage, terminalClose, type TerminalWsData } from './terminal';
import { logger } from '../lib/logger';
import { setAgentOnline, setAgentOffline, redis } from '../lib/redis';
import { db } from '../db/client';
import { users, chatChannelMembers, dmConversations } from '../db/schema';
import { eq, or } from 'drizzle-orm';
import { publishAgentStatus } from './publisher';

const softphoneOpen = async (ws: ServerWebSocket<WsData>) => {
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
};

const softphoneClose = async (ws: ServerWebSocket<WsData>) => {
  const { user } = ws.data;
  logger.info({ userId: user.sub }, 'WS disconnected');
  await setAgentOffline(user.sub);
  leaveAllRooms(ws);
  await db.update(users).set({ status: 'offline', statusChangedAt: new Date() }).where(eq(users.id, user.sub));
  if (user.tenantId) publishAgentStatus(user.tenantId, user.sub, 'offline');
};

// Single websocket handler — dispatches based on ws.data.kind. Bun.serve only
// supports one websocket handler per server, so all connection types funnel here.
export const wsHandler = {
  async open(ws: ServerWebSocket<AnyWsData>) {
    if ((ws.data as any).kind === 'terminal') {
      return terminalOpen(ws as ServerWebSocket<TerminalWsData>);
    }
    return softphoneOpen(ws as ServerWebSocket<WsData>);
  },

  message(ws: ServerWebSocket<AnyWsData>, message: string | Buffer) {
    if ((ws.data as any).kind === 'terminal') {
      return terminalMessage(ws as ServerWebSocket<TerminalWsData>, message);
    }
    const raw = typeof message === 'string' ? message : message.toString();
    handleMessage(ws as ServerWebSocket<WsData>, raw);
  },

  async close(ws: ServerWebSocket<AnyWsData>) {
    if ((ws.data as any).kind === 'terminal') {
      return terminalClose(ws as ServerWebSocket<TerminalWsData>);
    }
    return softphoneClose(ws as ServerWebSocket<WsData>);
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

// Single-use ticket auth (super_admin only). Ticket carries the bug context
// so the spawned claude session can be primed with it as the first prompt.
export async function upgradeTerminalWebSocket(req: Request, server: any): Promise<Response | undefined> {
  const url = new URL(req.url);
  const ticket = url.searchParams.get('ticket');
  if (!ticket) return new Response('Missing ticket', { status: 401 });

  // GET+DEL atomically — single use
  const multi = redis.multi();
  multi.get(`debugterm:${ticket}`);
  multi.del(`debugterm:${ticket}`);
  const results = await multi.exec();
  const payload = results?.[0]?.[1] as string | null;
  if (!payload) return new Response('Invalid or expired ticket', { status: 401 });

  let parsed: { userId: string; role: string; errorContext: string | null };
  try {
    parsed = JSON.parse(payload);
  } catch {
    return new Response('Malformed ticket payload', { status: 401 });
  }
  if (parsed.role !== 'super_admin') return new Response('Forbidden', { status: 403 });

  const upgraded = server.upgrade(req, {
    data: {
      kind: 'terminal',
      userId: parsed.userId,
      errorContext: parsed.errorContext,
    } satisfies TerminalWsData,
  });
  if (!upgraded) return new Response('WebSocket upgrade failed', { status: 500 });
  return undefined;
}
