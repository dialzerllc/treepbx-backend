import { createMiddleware } from 'hono/factory';
import { verifyToken, type JWTPayload } from '../lib/jwt';
import { Unauthorized } from '../lib/errors';

declare module 'hono' {
  interface ContextVariableMap {
    user: JWTPayload;
    tenantId: string | undefined;
  }
}

export const authMiddleware = createMiddleware(async (c, next) => {
  const header = c.req.header('Authorization');
  const queryToken = c.req.query('token');
  if (!header?.startsWith('Bearer ') && !queryToken) {
    throw new Unauthorized('Missing or invalid authorization header');
  }

  const token = header?.startsWith('Bearer ') ? header.slice(7) : queryToken!;
  try {
    const payload = await verifyToken(token);

    // Check token blacklist in Redis
    try {
      const { redis } = await import('../lib/redis');
      const blacklisted = await redis.get(`treepbx:blacklist:${token.slice(-16)}`);
      if (blacklisted) throw new Error('Token revoked');
    } catch (e: any) {
      if (e.message === 'Token revoked') throw new Unauthorized('Token has been revoked');
      // Redis down — allow through (fail-open)
    }

    c.set('user', payload);
    c.set('tenantId', payload.tenantId);
  } catch (e: any) {
    if (e instanceof Unauthorized) throw e;
    throw new Unauthorized('Invalid or expired token');
  }

  await next();
});
