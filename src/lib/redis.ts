import Redis from 'ioredis';
import { env } from '../env';

export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    return Math.min(times * 200, 5000);
  },
});

// Separate connection for pub/sub (subscriber can't run commands)
export const redisSub = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 3,
});

redis.on('connect', () => console.log('[Redis] Connected'));
redis.on('error', (err) => console.error('[Redis] Error:', err.message));

// ── Cache helpers ────────────────────────────────────────────────────────

const PREFIX = 'treepbx:';

export async function cacheGet<T>(key: string): Promise<T | null> {
  const val = await redis.get(PREFIX + key);
  return val ? JSON.parse(val) : null;
}

export async function cacheSet(key: string, data: unknown, ttlSeconds = 60): Promise<void> {
  await redis.set(PREFIX + key, JSON.stringify(data), 'EX', ttlSeconds);
}

export async function cacheDel(key: string): Promise<void> {
  await redis.del(PREFIX + key);
}

export async function cacheDelPattern(pattern: string): Promise<void> {
  const keys = await redis.keys(PREFIX + pattern);
  if (keys.length > 0) await redis.del(...keys);
}

// ── Call state helpers ───────────────────────────────────────────────────

export async function setCallState(callId: string, state: Record<string, unknown>, ttl = 3600): Promise<void> {
  await redis.set(`${PREFIX}call:${callId}`, JSON.stringify(state), 'EX', ttl);
}

export async function getCallState<T = Record<string, unknown>>(callId: string): Promise<T | null> {
  const val = await redis.get(`${PREFIX}call:${callId}`);
  return val ? JSON.parse(val) : null;
}

export async function delCallState(callId: string): Promise<void> {
  await redis.del(`${PREFIX}call:${callId}`);
}

// ── Agent presence ───────────────────────────────────────────────────────

export async function setAgentOnline(agentId: string, data: Record<string, unknown>): Promise<void> {
  await redis.hset(`${PREFIX}agents:online`, agentId, JSON.stringify(data));
}

export async function setAgentOffline(agentId: string): Promise<void> {
  await redis.hdel(`${PREFIX}agents:online`, agentId);
}

export async function getOnlineAgents(): Promise<Record<string, unknown>[]> {
  const all = await redis.hgetall(`${PREFIX}agents:online`);
  return Object.values(all).map((v) => JSON.parse(v));
}

// ── Rate limiting ────────────────────────────────────────────────────────

export async function checkRateLimit(key: string, maxAttempts: number, windowSeconds: number): Promise<{ allowed: boolean; remaining: number }> {
  const redisKey = `${PREFIX}rl:${key}`;
  const current = await redis.incr(redisKey);
  if (current === 1) {
    await redis.expire(redisKey, windowSeconds);
  }
  return {
    allowed: current <= maxAttempts,
    remaining: Math.max(0, maxAttempts - current),
  };
}
