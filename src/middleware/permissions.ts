import { createMiddleware } from 'hono/factory';
import { Forbidden } from '../lib/errors';

export function requirePermission(module: string, action: 'view' | 'create' | 'delete') {
  return createMiddleware(async (c, next) => {
    const user = c.get('user');
    // Super admin and tenant admin have full access
    if (user.role === 'super_admin' || user.role === 'tenant_admin') {
      return next();
    }

    const perms = user.permissions?.[module];
    if (!perms || !perms[action]) {
      throw new Forbidden(`Missing '${action}' permission on module '${module}'`);
    }

    await next();
  });
}
