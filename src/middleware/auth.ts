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
  if (!header?.startsWith('Bearer ')) {
    throw new Unauthorized('Missing or invalid authorization header');
  }

  const token = header.slice(7);
  try {
    const payload = await verifyToken(token);
    c.set('user', payload);
    c.set('tenantId', payload.tenantId);
  } catch {
    throw new Unauthorized('Invalid or expired token');
  }

  await next();
});
