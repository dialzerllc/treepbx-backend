import type { ServerWebSocket } from 'bun';
import type { JWTPayload } from '../lib/jwt';
import type { TerminalWsData } from './terminal';

export interface WsData {
  user: JWTPayload;
  rooms: Set<string>;
}

// Union of every connection kind handled by Bun.serve's single websocket handler.
export type AnyWsData = WsData | TerminalWsData;

// Room → set of websockets
const rooms = new Map<string, Set<ServerWebSocket<WsData>>>();

export function joinRoom(ws: ServerWebSocket<WsData>, room: string) {
  ws.data.rooms.add(room);
  if (!rooms.has(room)) rooms.set(room, new Set());
  rooms.get(room)!.add(ws);
}

export function leaveRoom(ws: ServerWebSocket<WsData>, room: string) {
  ws.data.rooms.delete(room);
  rooms.get(room)?.delete(ws);
  if (rooms.get(room)?.size === 0) rooms.delete(room);
}

export function leaveAllRooms(ws: ServerWebSocket<WsData>) {
  for (const room of ws.data.rooms) {
    rooms.get(room)?.delete(ws);
    if (rooms.get(room)?.size === 0) rooms.delete(room);
  }
  ws.data.rooms.clear();
}

export function broadcastToRoom(room: string, event: string, data: unknown) {
  const members = rooms.get(room);
  if (!members || members.size === 0) return;
  const message = JSON.stringify({ event, data });
  for (const ws of members) {
    ws.send(message);
  }
}

export function sendToAgent(agentId: string, event: string, data: unknown, excludeUserId?: string) {
  const room = rooms.get(`agent:${agentId}`);
  if (!room) return false;
  const message = JSON.stringify({ event, data });
  let sent = 0;
  for (const ws of room) {
    if (excludeUserId && ws.data.user.sub === excludeUserId) continue;
    ws.send(message);
    sent++;
  }
  return sent > 0;
}

export function broadcastToAll(event: string, data: unknown) {
  const message = JSON.stringify({ event, data });
  for (const [, members] of rooms) {
    for (const ws of members) {
      ws.send(message);
    }
  }
}
