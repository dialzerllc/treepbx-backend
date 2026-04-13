import type { ServerWebSocket } from 'bun';
import type { WsData } from './rooms';
import { broadcastToRoom } from './rooms';
import { logger } from '../lib/logger';

interface WsMessage {
  event: string;
  data?: unknown;
}

export function handleMessage(ws: ServerWebSocket<WsData>, raw: string) {
  try {
    const msg: WsMessage = JSON.parse(raw);
    const { user } = ws.data;

    switch (msg.event) {
      case 'agent:set_status': {
        const { status } = msg.data as { status: string };
        // Broadcast to tenant room
        if (user.tenantId) {
          broadcastToRoom(`tenant:${user.tenantId}`, 'agent:status', {
            agentId: user.sub,
            status,
          });
        }
        break;
      }

      case 'chat:send_message': {
        const { channelId, content } = msg.data as { channelId: string; content: string };
        broadcastToRoom(`chat:${channelId}`, 'chat:message', {
          channelId,
          senderId: user.sub,
          content,
          createdAt: new Date().toISOString(),
        });
        break;
      }

      case 'chat:typing_start': {
        const { channelId } = msg.data as { channelId: string };
        broadcastToRoom(`chat:${channelId}`, 'chat:typing', {
          channelId,
          userId: user.sub,
          typing: true,
        });
        break;
      }

      case 'chat:typing_stop': {
        const { channelId } = msg.data as { channelId: string };
        broadcastToRoom(`chat:${channelId}`, 'chat:typing', {
          channelId,
          userId: user.sub,
          typing: false,
        });
        break;
      }

      case 'supervisor:join_team': {
        const { teamId } = msg.data as { teamId: string };
        // Already joined tenant room, could add team-specific room
        break;
      }

      default:
        logger.debug({ event: msg.event }, 'Unknown WS event');
    }
  } catch (err) {
    logger.warn({ err }, 'Invalid WS message');
  }
}
