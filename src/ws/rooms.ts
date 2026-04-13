import type { ServerWebSocket } from 'bun';
import type { JWTPayload } from '../lib/jwt';

export interface WsData {
  user: JWTPayload;
  rooms: Set<string>;
}

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
  if (!members) return;
  const message = JSON.stringify({ event, data });
  for (const ws of members) {
    ws.send(message);
  }
}

export function broadcastToAll(event: string, data: unknown) {
  const message = JSON.stringify({ event, data });
  for (const [, members] of rooms) {
    for (const ws of members) {
      ws.send(message);
    }
  }
}
