import { createMiddleware } from 'hono/factory';
import { redis } from '../lib/redis';
import { logger } from '../lib/logger';

/**
 * Redis-backed sliding-window rate limiter.
 *
 * Uses INCR + EXPIRE — no sorted-set overhead. Accurate enough for abuse
 * deterrence; not a billing meter. On Redis error we fail open (log and
 * continue) because availability beats perfect limiting.
 *
 * Usage:
 *   app.use('/api/v1/public/*', rateLimit({ max: 20, windowSeconds: 60, prefix: 'public' }));
 *   app.use('/api/v1/auth/login', rateLimit({ max: 10, windowSeconds: 60, prefix: 'login' }));
 */
export function rateLimit(
  arg1: number | {
    max: number;
    windowSeconds: number;
    prefix: string;
    keyFn?: (ip: string, userSub?: string) => string;
  },
  windowMs?: number,
) {
  // Backwards compatibility: old signature was rateLimit(limit, windowMs)
  const opts = typeof arg1 === 'number'
    ? { max: arg1, windowSeconds: Math.floor((windowMs ?? 60_000) / 1000), prefix: 'default' }
    : arg1;

  return createMiddleware(async (c, next) => {
    const userSub = c.get('user' as never) as { sub?: string } | undefined;
    const ip = c.req.header('cf-connecting-ip')
      ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
      ?? 'unknown';
    const keyBase = opts.keyFn
      ? opts.keyFn(ip, userSub?.sub)
      : (userSub?.sub ?? ip);

    const key = `rl:${opts.prefix}:${keyBase}`;
    try {
      const count = await redis.incr(key);
      if (count === 1) await redis.expire(key, opts.windowSeconds);

      c.header('X-RateLimit-Limit', String(opts.max));
      c.header('X-RateLimit-Remaining', String(Math.max(0, opts.max - count)));

      if (count > opts.max) {
        const ttl = await redis.ttl(key);
        c.header('Retry-After', String(Math.max(1, ttl)));
        return c.json({ error: 'Too many requests', retryAfter: ttl }, 429);
      }
    } catch (err) {
      logger.warn({ err }, '[rate-limit] redis error; failing open');
    }

    await next();
  });
}
