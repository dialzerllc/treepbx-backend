import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, desc } from 'drizzle-orm';
import { db } from '../../db/client';
import { serviceMetricTargets, teams, queues } from '../../db/schema';
import { NotFound } from '../../lib/errors';
import { requireRole } from '../../middleware/roles';

const router = new Hono();

const targetSchema = z.object({
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  answerTimeSeconds: z.coerce.number().int().default(20),
  serviceLevelPct: z.coerce.number().int().min(0).max(100).default(80),
  maxWaitSeconds: z.coerce.number().int().default(120),
  maxAbandonPct: z.coerce.number().int().min(0).max(100).default(5),
  avgHandleTimeSeconds: z.coerce.number().int().default(300),
  avgWrapTimeSeconds: z.coerce.number().int().default(30),
  minAnswerRatePct: z.coerce.number().int().min(0).max(100).default(90),
  maxHoldTimeSeconds: z.coerce.number().int().default(60),
  maxRingTimeSeconds: z.coerce.number().int().default(30),
  minOccupancyPct: z.coerce.number().int().min(0).max(100).default(60),
  maxIdleTimeSeconds: z.coerce.number().int().default(300),
  minMosScore: z.union([z.number(), z.string()]).transform(String).default('3.5'),
  maxCallsPerHour: z.coerce.number().int().default(0),
  firstCallResolutionPct: z.coerce.number().int().min(0).max(100).default(70),
  assignedType: z.enum(['global', 'team', 'queue']).default('global'),
  assignedId: z.string().nullable().optional().transform((v) => v && /^[0-9a-f-]{36}$/i.test(v) ? v : null),
  active: z.boolean().default(true),
});

// List all targets
router.get('/', async (c) => {
  const tenantId = c.get('tenantId')!;
  const rows = await db.select().from(serviceMetricTargets)
    .where(eq(serviceMetricTargets.tenantId, tenantId))
    .orderBy(desc(serviceMetricTargets.createdAt));

  // Enrich with assignment name
  const enriched = await Promise.all(rows.map(async (r) => {
    let assignedName = 'Global (All)';
    if (r.assignedType === 'team' && r.assignedId) {
      const [t] = await db.select({ name: teams.name }).from(teams).where(eq(teams.id, r.assignedId));
      assignedName = t?.name ?? 'Unknown Team';
    } else if (r.assignedType === 'queue' && r.assignedId) {
      const [q] = await db.select({ name: queues.name }).from(queues).where(eq(queues.id, r.assignedId));
      assignedName = q?.name ?? 'Unknown Queue';
    }
    return { ...r, assignedName };
  }));

  return c.json({ data: enriched });
});

// Get single target
router.get('/:id', async (c) => {
  const tenantId = c.get('tenantId')!;
  const [row] = await db.select().from(serviceMetricTargets)
    .where(and(eq(serviceMetricTargets.id, c.req.param('id')), eq(serviceMetricTargets.tenantId, tenantId)));
  if (!row) throw new NotFound('Metric target not found');
  return c.json(row);
});

// Create target
router.post('/', requireRole('tenant_admin', 'supervisor'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = targetSchema.parse(await c.req.json());
  const [row] = await db.insert(serviceMetricTargets).values({ ...body, tenantId }).returning();
  return c.json(row, 201);
});

// Update target
router.put('/:id', requireRole('tenant_admin', 'supervisor'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = targetSchema.partial().parse(await c.req.json());
  const [row] = await db.update(serviceMetricTargets)
    .set({ ...body, updatedAt: new Date() })
    .where(and(eq(serviceMetricTargets.id, c.req.param('id')), eq(serviceMetricTargets.tenantId, tenantId)))
    .returning();
  if (!row) throw new NotFound('Metric target not found');
  return c.json(row);
});

// Delete target
router.delete('/:id', requireRole('tenant_admin', 'supervisor'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const [row] = await db.delete(serviceMetricTargets)
    .where(and(eq(serviceMetricTargets.id, c.req.param('id')), eq(serviceMetricTargets.tenantId, tenantId)))
    .returning();
  if (!row) throw new NotFound('Metric target not found');
  return c.json({ ok: true });
});

export default router;
