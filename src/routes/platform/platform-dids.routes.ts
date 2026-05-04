import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, like, desc, count, inArray, sql } from 'drizzle-orm';
import { db } from '../../db/client';
import { platformDids, platformDidGroups } from '../../db/schema';
import { paginationSchema, paginate, paginatedResponse } from '../../lib/pagination';
import { NotFound, BadRequest } from '../../lib/errors';

const router = new Hono();

const didSchema = z.object({
  number: z.string().min(1),
  provider: z.preprocess((v) => (typeof v === 'string' && v.trim() === '') ? 'unspecified' : v, z.string().min(1).default('unspecified')),
  city: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  country: z.string().default('US'),
  didType: z.enum(['local', 'tollfree', 'mobile']).default('local'),
  monthlyCost: z.string().default('0'),
  status: z.enum(['available', 'assigned', 'reserved', 'porting']).default('available'),
  tenantId: z.string().nullable().optional().transform((v) => v && /^[0-9a-f-]{36}$/i.test(v) ? v : null),
  groupId: z.string().nullable().optional().transform((v) => v && /^[0-9a-f-]{36}$/i.test(v) ? v : null),
  notes: z.string().nullable().optional(),
});

const groupSchema = z.object({
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  isDefault: z.boolean().nullable().default(false),
  visibleToAll: z.boolean().nullable().default(true),
  assignedTenantId: z.string().nullable().optional().transform((v) => v && /^[0-9a-f-]{36}$/i.test(v) ? v : null),
});

router.get('/', async (c) => {
  const raw = paginationSchema.extend({
    status: z.string().nullable().optional(),
    groupId: z.string().nullable().optional(),
  }).passthrough().parse(c.req.query());
  const { offset, limit } = paginate(raw);

  const conditions = [];
  if (raw.search) conditions.push(like(platformDids.number, `%${raw.search}%`));
  if (raw.status) conditions.push(eq(platformDids.status, raw.status));
  if (raw.groupId) conditions.push(eq(platformDids.groupId, raw.groupId));
  const where = conditions.length ? and(...conditions) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db.select().from(platformDids).where(where).orderBy(desc(platformDids.createdAt)).limit(limit).offset(offset),
    db.select({ total: count() }).from(platformDids).where(where),
  ]);

  return c.json(paginatedResponse(rows, Number(total), raw));
});

// DID Groups — must be before /:id to avoid route shadowing
router.get('/groups', async (c) => {
  const raw = paginationSchema.parse(c.req.query());
  const { offset, limit } = paginate(raw);
  const where = raw.search ? like(platformDidGroups.name, `%${raw.search}%`) : undefined;
  const [rows, [{ total }]] = await Promise.all([
    db.select().from(platformDidGroups).where(where).orderBy(desc(platformDidGroups.createdAt)).limit(limit).offset(offset),
    db.select({ total: count() }).from(platformDidGroups).where(where),
  ]);

  // Enrich with DID count, tenant name, and assignment status per group
  const { tenants } = await import('../../db/schema');
  const enriched = await Promise.all(rows.map(async (g) => {
    const [{ didCount }] = await db.select({ didCount: count() }).from(platformDids).where(eq(platformDids.groupId, g.id));

    let assignedTenant: string | null = null;
    let assignmentStatus: '' | 'pending' | 'accepted' | 'rejected' = '';
    if (g.assignedTenantId) {
      const [t] = await db.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, g.assignedTenantId));
      assignedTenant = t?.name ?? g.assignedTenantId;
      // Check if any DIDs in this group are assigned to the tenant
      const [{ assignedCount }] = await db.select({ assignedCount: count() }).from(platformDids)
        .where(and(eq(platformDids.groupId, g.id), eq(platformDids.tenantId, g.assignedTenantId), eq(platformDids.status, 'assigned')));
      assignmentStatus = Number(assignedCount) > 0 ? 'accepted' : 'pending';
    }

    return {
      ...g,
      didCount: Number(didCount),
      visibleToAllTenants: g.visibleToAll,
      assignedTenant,
      assignmentStatus,
    };
  }));

  return c.json(paginatedResponse(enriched, Number(total), raw));
});

router.post('/groups', async (c) => {
  const body = groupSchema.parse(await c.req.json());
  const [dup] = await db.select({ id: platformDidGroups.id }).from(platformDidGroups)
    .where(eq(platformDidGroups.name, body.name));
  if (dup) throw new BadRequest('DID group name already exists');
  const [row] = await db.insert(platformDidGroups).values(body).returning();
  return c.json(row, 201);
});

router.put('/groups/:id', async (c) => {
  const body = groupSchema.partial().parse(await c.req.json());
  if (body.name) {
    const [dup] = await db.select({ id: platformDidGroups.id }).from(platformDidGroups)
      .where(sql`${platformDidGroups.name} = ${body.name} AND ${platformDidGroups.id} != ${c.req.param('id')}`);
    if (dup) throw new BadRequest('DID group name already exists');
  }
  const [row] = await db.update(platformDidGroups).set(body).where(eq(platformDidGroups.id, c.req.param('id'))).returning();
  if (!row) throw new NotFound('DID group not found');
  return c.json(row);
});

router.delete('/groups/:id', async (c) => {
  const [row] = await db.delete(platformDidGroups).where(eq(platformDidGroups.id, c.req.param('id'))).returning();
  if (!row) throw new NotFound('DID group not found');
  return c.json({ ok: true });
});

// Assign DID group to tenant — only marks the group as offered, DIDs stay unchanged until tenant accepts
router.put('/groups/:id/assign', async (c) => {
  const groupId = c.req.param('id');
  const { tenantId } = z.object({ tenantId: z.string() }).passthrough().parse(await c.req.json());

  // Update group — just set assignedTenantId, don't touch DIDs yet
  const [group] = await db.update(platformDidGroups)
    .set({ assignedTenantId: tenantId || null })
    .where(eq(platformDidGroups.id, groupId))
    .returning();
  if (!group) throw new NotFound('DID group not found');

  return c.json({ ok: true, group });
});

// Revoke DID group assignment
router.put('/groups/:id/revoke', async (c) => {
  const groupId = c.req.param('id');

  const [group] = await db.update(platformDidGroups)
    .set({ assignedTenantId: null })
    .where(eq(platformDidGroups.id, groupId))
    .returning();
  if (!group) throw new NotFound('DID group not found');

  await db.update(platformDids)
    .set({ tenantId: null, status: 'available' })
    .where(eq(platformDids.groupId, groupId));

  return c.json({ ok: true });
});

// Accept DID group (from platform side - confirm assignment)
router.put('/groups/:id/accept', async (c) => {
  const groupId = c.req.param('id');
  const [group] = await db.select().from(platformDidGroups)
    .where(eq(platformDidGroups.id, groupId));
  if (!group) throw new NotFound('DID group not found');
  // Mark all DIDs in this group as assigned
  await db.update(platformDids)
    .set({ status: 'assigned' })
    .where(eq(platformDids.groupId, groupId));
  return c.json({ ok: true });
});

// Bulk move DIDs to a different group
router.put('/bulk-move', async (c) => {
  const body = z.object({
    didIds: z.array(z.string().uuid()),
    groupId: z.string().uuid(),
  }).parse(await c.req.json());

  await db.update(platformDids)
    .set({ groupId: body.groupId })
    .where(inArray(platformDids.id, body.didIds));

  return c.json({ ok: true, updated: body.didIds.length });
});

// Bulk delete platform DIDs. Detaches FK references from the tenant `dids`
// table first so the delete doesn't 500 with a foreign-key violation when
// any of the picked DIDs were ever assigned to a tenant.
router.post('/bulk-delete', async (c) => {
  const body = z.object({
    didIds: z.array(z.string().uuid()),
  }).parse(await c.req.json());

  if (body.didIds.length === 0) {
    return c.json({ ok: true, deleted: 0 });
  }

  // Lazy import to avoid loading the tenant dids module at platform-route eval time.
  const { dids } = await import('../../db/schema');

  // 1. Null-out the platformDidId reference on any tenant DIDs that point at
  //    these platform DIDs. Without this the FK on dids.platform_did_id
  //    rejects the delete.
  await db.update(dids).set({ platformDidId: null }).where(inArray(dids.platformDidId, body.didIds));

  // 2. Delete the platform DIDs themselves.
  const deleted = await db.delete(platformDids)
    .where(inArray(platformDids.id, body.didIds))
    .returning({ id: platformDids.id });

  return c.json({ ok: true, deleted: deleted.length });
});

router.get('/:id', async (c) => {
  const [row] = await db.select().from(platformDids).where(eq(platformDids.id, c.req.param('id')));
  if (!row) throw new NotFound('DID not found');
  return c.json(row);
});

router.post('/', async (c) => {
  const body = didSchema.parse(await c.req.json());
  // Auto-assign to Default group if no group specified
  if (!body.groupId) {
    const [defaultGroup] = await db.select({ id: platformDidGroups.id }).from(platformDidGroups).where(eq(platformDidGroups.isDefault, true)).limit(1);
    if (defaultGroup) body.groupId = defaultGroup.id;
  }
  // Check duplicate number
  const [dup] = await db.select({ id: platformDids.id }).from(platformDids).where(eq(platformDids.number, body.number));
  if (dup) throw new BadRequest('DID number already exists');

  const [row] = await db.insert(platformDids).values(body).returning();
  return c.json(row, 201);
});

// Bulk import — accepts an array of DID numbers + a groupId. Single DB
// round-trip with onConflictDoNothing on the unique number column, so
// re-uploads of the same CSV give accurate created/skipped counts instead of
// hanging the browser with N sequential POSTs.
router.post('/bulk-import', async (c) => {
  const body = z.object({
    numbers: z.array(z.string().min(1)).min(1).max(10000),
    groupId: z.string().nullable().optional().transform((v) => v && /^[0-9a-f-]{36}$/i.test(v) ? v : null),
    country: z.string().default('US'),
    didType: z.enum(['local', 'tollfree', 'mobile']).default('local'),
    provider: z.string().default('unspecified'),
  }).parse(await c.req.json());

  let groupId = body.groupId;
  if (!groupId) {
    const [defaultGroup] = await db.select({ id: platformDidGroups.id })
      .from(platformDidGroups).where(eq(platformDidGroups.isDefault, true)).limit(1);
    if (defaultGroup) groupId = defaultGroup.id;
  }

  // Dedupe within the upload itself, then insert with onConflictDoNothing on
  // the unique `number` index so existing DIDs are silently skipped.
  const uniqueNumbers = Array.from(new Set(body.numbers.map((n) => n.trim()).filter(Boolean)));
  const values = uniqueNumbers.map((number) => ({
    number,
    groupId,
    status: 'available' as const,
    country: body.country,
    didType: body.didType,
    provider: body.provider,
  }));

  const inserted = values.length > 0
    ? await db.insert(platformDids).values(values).onConflictDoNothing().returning({ id: platformDids.id })
    : [];

  return c.json({
    ok: true,
    submitted: body.numbers.length,
    deduped: uniqueNumbers.length,
    created: inserted.length,
    skipped: uniqueNumbers.length - inserted.length,
  });
});

router.put('/:id', async (c) => {
  const body = didSchema.partial().parse(await c.req.json());
  // If status set to available, clear tenant assignment
  if (body.status === 'available') {
    body.tenantId = null;
  }
  const [row] = await db.update(platformDids).set(body).where(eq(platformDids.id, c.req.param('id'))).returning();
  if (!row) throw new NotFound('DID not found');
  return c.json(row);
});

router.delete('/:id', async (c) => {
  const [row] = await db.delete(platformDids).where(eq(platformDids.id, c.req.param('id'))).returning();
  if (!row) throw new NotFound('DID not found');
  return c.json({ ok: true });
});

export default router;
