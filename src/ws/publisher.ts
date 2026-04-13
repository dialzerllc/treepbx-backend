import { broadcastToRoom } from './rooms';
import { logger } from '../lib/logger';

// Publish events from backend services to WebSocket clients
// In production, this subscribes to Redis Pub/Sub channels

export function publishCallEvent(tenantId: string, event: string, data: unknown) {
  broadcastToRoom(`tenant:${tenantId}`, event, data);
}

export function publishAgentStatus(tenantId: string, agentId: string, status: string) {
  broadcastToRoom(`tenant:${tenantId}`, 'agent:status', { agentId, status });
  broadcastToRoom(`agent:${agentId}`, 'agent:status', { agentId, status });
}

export function publishCallRinging(tenantId: string, agentId: string, callData: unknown) {
  broadcastToRoom(`agent:${agentId}`, 'call:ringing', callData);
  broadcastToRoom(`tenant:${tenantId}`, 'call:ringing', callData);
}

export function publishCallEnded(tenantId: string, agentId: string, callData: unknown) {
  broadcastToRoom(`agent:${agentId}`, 'call:ended', callData);
  broadcastToRoom(`tenant:${tenantId}`, 'call:ended', callData);
}

export function publishChatMessage(channelId: string, message: unknown) {
  broadcastToRoom(`chat:${channelId}`, 'chat:message', message);
}

export function publishFraudAlert(tenantId: string, alert: unknown) {
  broadcastToRoom(`tenant:${tenantId}`, 'fraud:alert', alert);
}

export function publishDashboardStats(tenantId: string, stats: unknown) {
  broadcastToRoom(`tenant:${tenantId}`, 'dashboard:stats', stats);
}
