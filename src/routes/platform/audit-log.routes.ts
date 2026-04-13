import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, like, desc, count, gte, lte, or } from 'drizzle-orm';
import { db } from '../../db/client';
import { auditLog } from '../../db/schema';
import { paginationSchema, paginate, paginatedResponse } from '../../lib/pagination';

const router = new Hono();

router.get('/', async (c) => {
  const raw = paginationSchema.extend({
    tenantId: z.string().uuid().optional(),
    userId: z.string().uuid().optional(),
    action: z.string().optional(),
    resourceType: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
  }).parse(c.req.query());
  const { offset, limit } = paginate(raw);

  const conditions: any[] = [];
  if (raw.tenantId) conditions.push(eq(auditLog.tenantId, raw.tenantId));
  if (raw.userId) conditions.push(eq(auditLog.userId, raw.userId));
  if (raw.action) conditions.push(like(auditLog.action, `%${raw.action}%`));
  if (raw.resourceType) conditions.push(eq(auditLog.resourceType, raw.resourceType));
  if (raw.from) conditions.push(gte(auditLog.createdAt, new Date(raw.from)));
  if (raw.to) conditions.push(lte(auditLog.createdAt, new Date(raw.to)));
  if (raw.search) {
    conditions.push(
      or(
        like(auditLog.action, `%${raw.search}%`),
        like(auditLog.resourceType, `%${raw.search}%`),
        like(auditLog.resourceLabel!, `%${raw.search}%`),
      )!
    );
  }

  const where = conditions.length ? and(...conditions) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db.select().from(auditLog).where(where).orderBy(desc(auditLog.createdAt)).limit(limit).offset(offset),
    db.select({ total: count() }).from(auditLog).where(where),
  ]);

  return c.json(paginatedResponse(rows, Number(total), raw));
});

export default router;
