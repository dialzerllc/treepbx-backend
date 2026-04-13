import { createMiddleware } from 'hono/factory';
import { nanoid } from 'nanoid';

export const requestIdMiddleware = createMiddleware(async (c, next) => {
  const requestId = c.req.header('X-Request-ID') ?? nanoid();
  c.header('X-Request-ID', requestId);
  await next();
});
