import { createMiddleware } from 'hono/factory';
import { Forbidden } from '../lib/errors';

export const requireTenant = createMiddleware(async (c, next) => {
  const tenantId = c.get('tenantId');
  if (!tenantId) {
    throw new Forbidden('Tenant context required');
  }
  await next();
});
