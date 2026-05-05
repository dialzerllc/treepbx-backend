import { Hono } from 'hono';
import { z } from 'zod';
import { eq, like, asc, desc, count, and, inArray } from 'drizzle-orm';
import { db } from '../../db/client';
import { scalingRules, scalingEvents, hetznerServers } from '../../db/schema';
import { paginationSchema, paginate, paginatedResponse } from '../../lib/pagination';
import { NotFound } from '../../lib/errors';
import { observer } from '../../autoscaler/observer';
import { planner, type PlannerRule } from '../../autoscaler/planner';
import { ruleCooldownActive } from '../../autoscaler/state';

const router = new Hono();

const FALLBACK_STRATEGIES = ['wait', 'region', 'any', 'custom'] as const;

const ruleSchema = z.object({
  name: z.string().min(1),
  serviceType: z.string().min(1),
  serverType: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  metric: z.string().min(1),
  thresholdUp: z.string(),
  thresholdDown: z.string(),
  minInstances: z.coerce.number().int().default(1),
  maxInstances: z.coerce.number().int().default(10),
  cooldownSeconds: z.coerce.number().int().default(300),
  callsPerInstance: z.coerce.number().int().default(0),
  priority: z.coerce.number().int().default(100),
  fallbackStrategy: z.enum(FALLBACK_STRATEGIES).default('region'),
  fallbackLocation: z.string().nullable().optional(),
  enabled: z.boolean().nullable().default(true),
});

router.get('/', async (c) => {
  const raw = paginationSchema.parse(c.req.query());
  const { offset, limit } = paginate(raw);
  const where = raw.search ? like(scalingRules.name, `%${raw.search}%`) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db.select().from(scalingRules).where(where)
      .orderBy(asc(scalingRules.priority), desc(scalingRules.createdAt))
      .limit(limit).offset(offset),
    db.select({ total: count() }).from(scalingRules).where(where),
  ]);
  return c.json(paginatedResponse(rows, Number(total), raw));
});

// Named routes must be before /:id to avoid route shadowing
// Scaling events history
router.get('/events', async (c) => {
  const raw = paginationSchema.extend({
    serviceType: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
  }).passthrough().parse(c.req.query());
  const { offset, limit } = paginate(raw);

  const conditions = [];
  if (raw.serviceType) conditions.push(eq(scalingEvents.serviceType, raw.serviceType));
  if (raw.status) conditions.push(eq(scalingEvents.status, raw.status));
  const where = conditions.length ? and(...conditions) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db.select().from(scalingEvents).where(where).orderBy(desc(scalingEvents.createdAt)).limit(limit).offset(offset),
    db.select({ total: count() }).from(scalingEvents).where(where),
  ]);
  return c.json(paginatedResponse(rows, Number(total), raw));
});

// Hetzner servers infra dashboard
router.get('/hetzner', async (c) => {
  const raw = paginationSchema.extend({
    role: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
  }).passthrough().parse(c.req.query());
  const { offset, limit } = paginate(raw);

  const conditions = [];
  if (raw.role) conditions.push(eq(hetznerServers.role, raw.role));
  if (raw.status) conditions.push(eq(hetznerServers.status, raw.status));
  const where = conditions.length ? and(...conditions) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db.select().from(hetznerServers).where(where).orderBy(desc(hetznerServers.createdAt)).limit(limit).offset(offset),
    db.select({ total: count() }).from(hetznerServers).where(where),
  ]);
  return c.json(paginatedResponse(rows, Number(total), raw));
});

/**
 * PUT /platform/scaling/reorder
 * Body: { order: string[] }  (UUIDs in priority order, lowest priority first)
 * Updates each rule's priority to its index in the array (×10 so manual inserts
 * are easy: a new rule can sit between priority 20 and 30 at 25).
 */
const reorderBody = z.object({
  order: z.array(z.string().uuid()).min(1),
});
router.put('/reorder', async (c) => {
  const { order } = reorderBody.parse(await c.req.json());

  const existing = await db.select({ id: scalingRules.id })
    .from(scalingRules).where(inArray(scalingRules.id, order));
  if (existing.length !== order.length) {
    throw new NotFound('One or more rule IDs not found');
  }

  await db.transaction(async (tx) => {
    for (let i = 0; i < order.length; i++) {
      await tx.update(scalingRules)
        .set({ priority: (i + 1) * 10 })
        .where(eq(scalingRules.id, order[i]));
    }
  });

  return c.json({ ok: true, updated: order.length });
});

/**
 * POST /platform/scaling/:id/test
 * Simulates this rule against the current observation and returns the predicted
 * plan. Side-effect free — no decisions are written. Useful for the modal's
 * "test against current observation" button.
 */
router.post('/:id/test', async (c) => {
  const id = c.req.param('id');
  const [rule] = await db.select().from(scalingRules).where(eq(scalingRules.id, id));
  if (!rule) throw new NotFound('Scaling rule not found');

  const obs = await observer();

  // Force-match this rule by passing it as the only candidate. Any disabled
  // flag is honored — the test reflects what would happen *if* the rule fired,
  // not whether the operator left it disabled.
  const plannerRule: PlannerRule = {
    id: rule.id,
    name: rule.name,
    serviceType: rule.serviceType,
    enabled: true,
    priority: rule.priority,
    minInstances: rule.minInstances,
    maxInstances: rule.maxInstances,
    callsPerInstance: rule.callsPerInstance,
    cooldownSeconds: rule.cooldownSeconds,
  };
  const serviceObs = (obs as any)[rule.serviceType] ?? obs.freeswitch;
  const plan = planner(serviceObs, [plannerRule]);
  const cooldownBlocked = await ruleCooldownActive(rule.id, rule.cooldownSeconds ?? 300);

  const wouldDo = cooldownBlocked
    ? 'skip (cooldown)'
    : plan.provision > 0
      ? `provision +${plan.provision}× ${rule.serverType ?? 'auto'}`
      : 'no change (within capacity)';

  return c.json({
    rule: { id: rule.id, name: rule.name, enabled: rule.enabled },
    observation: obs,
    plan,
    cooldown: { blocked: cooldownBlocked, seconds: rule.cooldownSeconds ?? 300 },
    wouldDo,
  });
});

router.get('/:id', async (c) => {
  const [row] = await db.select().from(scalingRules).where(eq(scalingRules.id, c.req.param('id')));
  if (!row) throw new NotFound('Scaling rule not found');
  return c.json(row);
});

router.post('/', async (c) => {
  const body = ruleSchema.parse(await c.req.json());
  const [row] = await db.insert(scalingRules).values(body).returning();
  return c.json(row, 201);
});

router.put('/:id', async (c) => {
  const body = ruleSchema.partial().parse(await c.req.json());
  const [row] = await db.update(scalingRules).set(body).where(eq(scalingRules.id, c.req.param('id'))).returning();
  if (!row) throw new NotFound('Scaling rule not found');
  return c.json(row);
});

router.delete('/:id', async (c) => {
  const [row] = await db.delete(scalingRules).where(eq(scalingRules.id, c.req.param('id'))).returning();
  if (!row) throw new NotFound('Scaling rule not found');
  return c.json({ ok: true });
});

export default router;
