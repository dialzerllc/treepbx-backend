import { createMiddleware } from 'hono/factory';
import { db } from '../db/client';
import { auditLog } from '../db/schema';

export function auditAction(action: string, resourceType: string) {
  return createMiddleware(async (c, next) => {
    await next();

    // Only log successful mutations
    const status = c.res.status;
    if (status >= 200 && status < 300) {
      const user = c.get('user');
      try {
        await db.insert(auditLog).values({
          userId: user?.sub,
          tenantId: user?.tenantId,
          action,
          resourceType,
          ipAddress: c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip'),
          statusCode: status,
        });
      } catch {
        // Don't fail the request if audit logging fails
      }
    }
  });
}
