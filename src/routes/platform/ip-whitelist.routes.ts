import { Hono } from 'hono';
import { z } from 'zod';
import { eq, desc } from 'drizzle-orm';
import { db } from '../../db/client';
import { platformIpWhitelist } from '../../db/schema';
import { NotFound, BadRequest } from '../../lib/errors';
import { requireRole } from '../../middleware/roles';

const router = new Hono();

router.use('*', requireRole('super_admin', 'platform_supervisor'));

const cidrSchema = z.string().regex(
  /^(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)){3}(\/([0-9]|[12]\d|3[0-2]))?$/,
  'must be an IPv4 address or CIDR (e.g. 203.0.113.5 or 203.0.113.0/24)',
);

const ruleSchema = z.object({
  cidr: cidrSchema,
  label: z.string().max(120).nullable().optional(),
  enabled: z.boolean().default(true),
});

router.get('/', async (c) => {
  const rows = await db.select().from(platformIpWhitelist).orderBy(desc(platformIpWhitelist.createdAt));
  return c.json({ data: rows });
});

router.post('/', async (c) => {
  const body = ruleSchema.parse(await c.req.json());
  const user = c.get('user');
  const [row] = await db.insert(platformIpWhitelist).values({ ...body, createdBy: user.sub }).returning();
  return c.json(row, 201);
});

router.put('/:id', async (c) => {
  const body = ruleSchema.partial().parse(await c.req.json());
  const [row] = await db.update(platformIpWhitelist).set(body).where(eq(platformIpWhitelist.id, c.req.param('id'))).returning();
  if (!row) throw new NotFound('Rule not found');
  return c.json(row);
});

router.delete('/:id', async (c) => {
  const [row] = await db.delete(platformIpWhitelist).where(eq(platformIpWhitelist.id, c.req.param('id'))).returning();
  if (!row) throw new NotFound('Rule not found');
  return c.json({ ok: true });
});

export default router;
