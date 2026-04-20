import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, like, desc, count, inArray, sql, isNull } from 'drizzle-orm';
import { db } from '../../db/client';
import { leadLists, leads, agentLeadLists, users } from '../../db/schema';
import { paginationSchema, paginate, paginatedResponse } from '../../lib/pagination';
import { NotFound, BadRequest } from '../../lib/errors';
import { requireRole } from '../../middleware/roles';

const router = new Hono();

// Ensure a default lead list exists for the tenant, return its ID
async function ensureDefaultList(tenantId: string): Promise<string> {
  const [existing] = await db.select({ id: leadLists.id }).from(leadLists)
    .where(and(eq(leadLists.tenantId, tenantId), eq(leadLists.isDefault, true)));
  if (existing) return existing.id;
  const [row] = await db.insert(leadLists).values({
    tenantId, name: 'Default', description: 'Default lead list', isDefault: true, source: 'system',
  }).returning();
  return row.id;
}

const leadListSchema = z.object({
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  source: z.string().default('manual'),
  status: z.enum(['active', 'paused', 'completed', 'archived', 'processing']).default('active'),
  timezone: z.string().nullable().optional(),
  assignmentType: z.enum(['campaign', 'agents']).nullable().optional(),
  assignedCampaignId: z.string().uuid().nullable().optional(),
});

function normalizeAssignment(
  assignmentType: 'campaign' | 'agents' | null | undefined,
): { assignmentType: string | null; assignedCampaignId: null } {
  if (assignmentType === 'campaign' || assignmentType === 'agents') {
    return { assignmentType, assignedCampaignId: null };
  }
  return { assignmentType: null, assignedCampaignId: null };
}

router.get('/', async (c) => {
  const tenantId = c.get('tenantId')!;
  await ensureDefaultList(tenantId);

  const raw = paginationSchema.extend({
    status: z.string().nullable().optional(),
    availableForCampaignId: z.string().uuid().nullable().optional(),
    assignmentFilter: z.enum(['unassigned', 'campaign', 'agents']).nullable().optional(),
  }).passthrough().parse(c.req.query());
  const { offset, limit } = paginate(raw);

  // Cache key varies by filter params (filters don't participate in cache, so only cache vanilla list)
  const isFilteredRequest = raw.availableForCampaignId || raw.assignmentFilter || raw.search || raw.status;
  const { cacheGet, cacheSet } = await import('../../lib/redis');
  const cacheKey = `leadlists:${tenantId}`;
  if (!isFilteredRequest) {
    const cached = await cacheGet(cacheKey);
    if (cached) return c.json(cached);
  }

  const conditions: any[] = [eq(leadLists.tenantId, tenantId)];
  if (raw.search) conditions.push(like(leadLists.name, `%${raw.search}%`));
  if (raw.status) conditions.push(eq(leadLists.status, raw.status));
  if (raw.availableForCampaignId) {
    conditions.push(eq(leadLists.assignmentType, 'campaign'));
  } else if (raw.assignmentFilter === 'unassigned') {
    conditions.push(isNull(leadLists.assignmentType));
  } else if (raw.assignmentFilter) {
    conditions.push(eq(leadLists.assignmentType, raw.assignmentFilter));
  }
  const where = and(...conditions);

  const [rows, [{ total }]] = await Promise.all([
    db.select().from(leadLists).where(where).orderBy(desc(leadLists.createdAt)).limit(limit).offset(offset),
    db.select({ total: count() }).from(leadLists).where(where),
  ]);

  // Enrich with live lead count (batch query instead of N+1)
  const listIds = rows.map((r) => r.id);
  const leadCounts = listIds.length > 0
    ? await db.select({ leadListId: leads.leadListId, leadCount: count() }).from(leads)
        .where(inArray(leads.leadListId, listIds))
        .groupBy(leads.leadListId)
    : [];
  const countMap = Object.fromEntries(leadCounts.map((r) => [r.leadListId, Number(r.leadCount)]));
  const enriched = rows.map((list) => ({ ...list, leadCount: countMap[list.id] ?? 0 }));

  const result = paginatedResponse(enriched, Number(total), raw);
  if (!isFilteredRequest) await cacheSet(cacheKey, result, 30);
  return c.json(result);
});

router.get('/:id', async (c) => {
  const tenantId = c.get('tenantId')!;
  const [row] = await db.select().from(leadLists)
    .where(and(eq(leadLists.id, c.req.param('id')), eq(leadLists.tenantId, tenantId)));
  if (!row) throw new NotFound('Lead list not found');
  return c.json(row);
});

// Get random sample of leads from a list
router.get('/:id/sample', async (c) => {
  const tenantId = c.get('tenantId')!;
  const listId = c.req.param('id');
  const [list] = await db.select({ id: leadLists.id }).from(leadLists)
    .where(and(eq(leadLists.id, listId), eq(leadLists.tenantId, tenantId)));
  if (!list) throw new NotFound('Lead list not found');

  const rows = await db.select({
    id: leads.id,
    phone: leads.phone,
    firstName: leads.firstName,
    lastName: leads.lastName,
    email: leads.email,
    company: leads.company,
    status: leads.status,
    attempts: leads.attempts,
  }).from(leads)
    .where(eq(leads.leadListId, listId))
    .orderBy(sql`random()`)
    .limit(10);

  return c.json({ data: rows });
});

router.post('/', requireRole('tenant_admin', 'supervisor'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = leadListSchema.parse(await c.req.json());
  const assignment = normalizeAssignment(body.assignmentType);

  const [dup] = await db.select({ id: leadLists.id }).from(leadLists)
    .where(and(eq(leadLists.name, body.name), eq(leadLists.tenantId, tenantId)));
  if (dup) throw new BadRequest('Lead list name already exists');

  const [row] = await db.insert(leadLists).values({ ...body, ...assignment, tenantId }).onConflictDoNothing().returning();
  if (!row) throw new BadRequest('Lead list name already exists');
  const { cacheDelPattern } = await import('../../lib/redis');
  await cacheDelPattern(`leadlists:${tenantId}*`);
  return c.json(row, 201);
});

router.put('/:id', requireRole('tenant_admin', 'supervisor'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const listId = c.req.param('id');
  const body = leadListSchema.partial().parse(await c.req.json());

  if (body.name) {
    const [dup] = await db.select({ id: leadLists.id }).from(leadLists)
      .where(and(eq(leadLists.name, body.name), eq(leadLists.tenantId, tenantId), sql`${leadLists.id} != ${listId}`));
    if (dup) throw new BadRequest('Lead list name already exists');
  }

  const updateBody: Record<string, unknown> = { ...body };
  delete updateBody.assignmentType;
  delete updateBody.assignedCampaignId;
  if ('assignmentType' in body || 'assignedCampaignId' in body) {
    const [prev] = await db.select({ assignmentType: leadLists.assignmentType }).from(leadLists)
      .where(and(eq(leadLists.id, listId), eq(leadLists.tenantId, tenantId)));
    const assignment = normalizeAssignment(body.assignmentType);
    updateBody.assignmentType = assignment.assignmentType;
    updateBody.assignedCampaignId = assignment.assignedCampaignId;
    // Leaving "agents" → clear agent assignments
    if (prev?.assignmentType === 'agents' && assignment.assignmentType !== 'agents') {
      await db.delete(agentLeadLists).where(eq(agentLeadLists.leadListId, listId));
    }
  }

  const [row] = await db.update(leadLists).set(updateBody)
    .where(and(eq(leadLists.id, listId), eq(leadLists.tenantId, tenantId)))
    .returning();
  if (!row) throw new NotFound('Lead list not found');
  const { cacheDelPattern } = await import('../../lib/redis');
  await cacheDelPattern(`leadlists:${tenantId}*`);
  return c.json(row);
});

// Bulk delete lead lists
router.post('/bulk/delete', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = z.object({ ids: z.array(z.string().uuid()) }).parse(await c.req.json());

  // Exclude default list from deletion
  const nonDefaultIds = body.ids.length > 0
    ? (await db.select({ id: leadLists.id }).from(leadLists)
        .where(and(inArray(leadLists.id, body.ids), eq(leadLists.tenantId, tenantId), eq(leadLists.isDefault, false))))
        .map((r) => r.id)
    : [];
  if (nonDefaultIds.length === 0) throw new BadRequest('Cannot delete the default list');

  // Remove FK references before deleting
  await db.delete(agentLeadLists).where(inArray(agentLeadLists.leadListId, nonDefaultIds));
  await db.delete(leads).where(and(inArray(leads.leadListId, nonDefaultIds), eq(leads.tenantId, tenantId)));

  const deleted = await db.delete(leadLists)
    .where(and(inArray(leadLists.id, nonDefaultIds), eq(leadLists.tenantId, tenantId)))
    .returning({ id: leadLists.id });

  const { cacheDelPattern } = await import('../../lib/redis');
  await cacheDelPattern(`leadlists:${tenantId}*`);
  return c.json({ ok: true, deleted: deleted.length });
});

router.delete('/:id', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;

  // Prevent deleting default list
  const [check] = await db.select({ isDefault: leadLists.isDefault }).from(leadLists)
    .where(and(eq(leadLists.id, c.req.param('id')), eq(leadLists.tenantId, tenantId)));
  if (check?.isDefault) throw new BadRequest('Cannot delete the default list');

  const listId = c.req.param('id');
  await db.delete(agentLeadLists).where(eq(agentLeadLists.leadListId, listId));
  await db.delete(leads).where(and(eq(leads.leadListId, listId), eq(leads.tenantId, tenantId)));

  const [row] = await db.delete(leadLists)
    .where(and(eq(leadLists.id, listId), eq(leadLists.tenantId, tenantId)))
    .returning();
  if (!row) throw new NotFound('Lead list not found');
  const { cacheDelPattern } = await import('../../lib/redis');
  await cacheDelPattern(`leadlists:${tenantId}*`);
  return c.json({ ok: true });
});

// Get agents assigned to a lead list
router.get('/:id/agents', async (c) => {
  const rows = await db.select({
    agentId: agentLeadLists.agentId,
    firstName: users.firstName,
    lastName: users.lastName,
    email: users.email,
  }).from(agentLeadLists)
    .innerJoin(users, eq(agentLeadLists.agentId, users.id))
    .where(eq(agentLeadLists.leadListId, c.req.param('id')));
  return c.json({ data: rows });
});

// Assign agents to a lead list
router.put('/:id/agents', requireRole('tenant_admin', 'supervisor'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const listId = c.req.param('id');
  const body = z.object({ agentIds: z.array(z.string().uuid()) }).parse(await c.req.json());

  const [list] = await db.select({ id: leadLists.id, assignmentType: leadLists.assignmentType }).from(leadLists)
    .where(and(eq(leadLists.id, listId), eq(leadLists.tenantId, tenantId)));
  if (!list) throw new NotFound('Lead list not found');
  if (list.assignmentType !== 'agents') throw new BadRequest('This list is not set to "agents" assignment mode');

  if (body.agentIds.length > 0) {
    const validAgents = await db.select({ id: users.id }).from(users)
      .where(and(inArray(users.id, body.agentIds), eq(users.tenantId, tenantId)));
    if (validAgents.length !== body.agentIds.length) throw new BadRequest('One or more agents not found');
  }

  await db.delete(agentLeadLists).where(eq(agentLeadLists.leadListId, listId));
  if (body.agentIds.length > 0) {
    await db.insert(agentLeadLists).values(body.agentIds.map((agentId) => ({ agentId, leadListId: listId })));
  }

  const { cacheDelPattern } = await import('../../lib/redis');
  await cacheDelPattern(`agents:${tenantId}*`);
  return c.json({ ok: true, assigned: body.agentIds.length });
});

// Remove duplicate phone numbers across all lists in this tenant (keeps oldest entry)
router.post('/remove-duplicates', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;

  const result = await db.execute(sql`
    DELETE FROM leads a USING leads b
    WHERE a.tenant_id = ${tenantId} AND b.tenant_id = ${tenantId}
    AND a.phone = b.phone AND a.id > b.id
    RETURNING a.id
  `);
  const removed = (result as any).length ?? (result as any).rowCount ?? 0;

  // Update lead counts on all lists
  const allLists = await db.select({ id: leadLists.id }).from(leadLists).where(eq(leadLists.tenantId, tenantId));
  for (const list of allLists) {
    const [{ cnt }] = await db.select({ cnt: count() }).from(leads).where(eq(leads.leadListId, list.id));
    await db.update(leadLists).set({ leadCount: Number(cnt) }).where(eq(leadLists.id, list.id));
  }

  const { cacheDelPattern } = await import('../../lib/redis');
  await cacheDelPattern(`leadlists:${tenantId}*`);
  return c.json({ ok: true, removed });
});

// Remove duplicate phone numbers within a specific list
router.post('/:id/remove-duplicates', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const listId = c.req.param('id');

  const result = await db.execute(sql`
    DELETE FROM leads a USING leads b
    WHERE a.lead_list_id = ${listId} AND b.lead_list_id = ${listId}
    AND a.tenant_id = ${tenantId} AND b.tenant_id = ${tenantId}
    AND a.phone = b.phone AND a.id > b.id
    RETURNING a.id
  `);
  const removed = (result as any).length ?? (result as any).rowCount ?? 0;

  const [{ cnt }] = await db.select({ cnt: count() }).from(leads).where(eq(leads.leadListId, listId));
  await db.update(leadLists).set({ leadCount: Number(cnt) }).where(eq(leadLists.id, listId));

  const { cacheDelPattern } = await import('../../lib/redis');
  await cacheDelPattern(`leadlists:${tenantId}*`);
  return c.json({ ok: true, removed });
});

export default router;
