import { createMiddleware } from 'hono/factory';
import { Forbidden } from '../lib/errors';

const ROLE_HIERARCHY: Record<string, number> = {
  super_admin: 100,
  platform_supervisor: 90,
  tenant_admin: 80,
  supervisor: 60,
  agent: 20,
};

export function requireRole(...roles: string[]) {
  return createMiddleware(async (c, next) => {
    const user = c.get('user');
    if (!user || !roles.includes(user.role)) {
      throw new Forbidden(`Role '${user?.role}' not authorized`);
    }
    await next();
  });
}

export function requireMinRole(minRole: string) {
  return createMiddleware(async (c, next) => {
    const user = c.get('user');
    const userLevel = ROLE_HIERARCHY[user?.role] ?? 0;
    const requiredLevel = ROLE_HIERARCHY[minRole] ?? 100;
    if (userLevel < requiredLevel) {
      throw new Forbidden(`Insufficient role level`);
    }
    await next();
  });
}
