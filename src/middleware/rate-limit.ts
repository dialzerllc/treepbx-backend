import { createMiddleware } from 'hono/factory';

// Simple in-memory rate limiter (replace with Redis in production)
const counters = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(limit: number, windowMs = 60000) {
  return createMiddleware(async (c, next) => {
    const key = c.get('user')?.sub ?? c.req.header('x-forwarded-for') ?? 'anonymous';
    const now = Date.now();

    let entry = counters.get(key);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      counters.set(key, entry);
    }

    entry.count++;
    c.header('X-RateLimit-Limit', String(limit));
    c.header('X-RateLimit-Remaining', String(Math.max(0, limit - entry.count)));

    if (entry.count > limit) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    await next();
  });
}
