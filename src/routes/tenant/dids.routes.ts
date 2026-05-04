import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, like, desc, count, inArray, sql } from 'drizzle-orm';
import { db } from '../../db/client';
import { dids, didGroups, byocCarriers, platformDids, platformDidGroups, agentDids, stirDidAttestations, ivrMenus, teams, queues, users } from '../../db/schema';
import { paginationSchema, paginate, paginatedResponse } from '../../lib/pagination';
import { NotFound, BadRequest } from '../../lib/errors';
import { requireRole } from '../../middleware/roles';
import { optionalUuid } from '../../lib/zod-helpers';

const router = new Hono();

const didSchema = z.object({
  number: z.string().min(1),
  description: z.string().nullable().optional(),
  cnam: z.string().max(15).nullable().optional(),
  country: z.string().default('US'),
  city: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  didType: z.enum(['local', 'tollfree', 'international']).default('local'),
  didGroupId: z.string().nullable().optional().transform((v) => v && /^[0-9a-f-]{36}$/i.test(v) ? v : null),
  byocCarrierId: z.string().nullable().optional().transform((v) => v && /^[0-9a-f-]{36}$/i.test(v) ? v : null),
  active: z.boolean().nullable().default(true),
  routeType: z.string().default('ivr'),
  routeTargetId: z.string().nullable().optional().transform((v) => v && /^[0-9a-f-]{36}$/i.test(v) ? v : null),
  unknownCallerRoute: z.string().nullable().optional(),
  repeatCallerRoute: z.string().nullable().optional(),
  platformDidId: z.string().nullable().optional().transform((v) => v && /^[0-9a-f-]{36}$/i.test(v) ? v : null),
});

const didGroupSchema = z.object({
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  strategy: z.enum(['round_robin', 'sequential', 'random']).default('round_robin'),
  defaultRoute: z.string().nullable().optional(),
  callerIdStrategy: z.enum(['fixed', 'random', 'local_match']).default('fixed'),
});

// Frontend stores route as a combined string ("IVR: Main Menu", "Queue: Sales",
// "Voicemail", "None"…). Backend needs (routeType, routeTargetId). This resolver
// looks up the target by name within the tenant's IVRs / teams / agents and
// returns the persisted shape. Returns null target for type-only routes
// (Voicemail, External, None).
async function resolveRoute(combined: string | undefined, tenantId: string): Promise<{ routeType: string; routeTargetId: string | null } | null> {
  if (!combined) return null;
  const trimmed = combined.trim();
  if (!trimmed || trimmed === 'None') return { routeType: 'none', routeTargetId: null };
  if (trimmed === 'Voicemail') return { routeType: 'voicemail', routeTargetId: null };
  if (trimmed === 'External') return { routeType: 'external', routeTargetId: null };

  const colonIdx = trimmed.indexOf(':');
  if (colonIdx < 0) return { routeType: trimmed.toLowerCase(), routeTargetId: null };
  const typeRaw = trimmed.slice(0, colonIdx).trim().toLowerCase();
  const targetName = trimmed.slice(colonIdx + 1).trim();
  if (!targetName) return { routeType: typeRaw, routeTargetId: null };

  let targetId: string | null = null;
  if (typeRaw === 'ivr') {
    const [m] = await db.select({ id: ivrMenus.id }).from(ivrMenus)
      .where(and(eq(ivrMenus.tenantId, tenantId), eq(ivrMenus.name, targetName)));
    targetId = m?.id ?? null;
  } else if (typeRaw === 'queue' || typeRaw === 'team') {
    // Try queues first, fall back to teams (UI sometimes labels Team:)
    const [q] = await db.select({ id: queues.id }).from(queues)
      .where(and(eq(queues.tenantId, tenantId), eq(queues.name, targetName)));
    if (q) targetId = q.id;
    else {
      const [t] = await db.select({ id: teams.id }).from(teams)
        .where(and(eq(teams.tenantId, tenantId), eq(teams.name, targetName)));
      targetId = t?.id ?? null;
    }
  } else if (typeRaw === 'agent') {
    // FE option value is "First Last" — match that first, fall back to
    // sipUsername (older entries / rare missing-name cases).
    const allAgents = await db.select({ id: users.id, firstName: users.firstName, lastName: users.lastName, sipUsername: users.sipUsername })
      .from(users).where(eq(users.tenantId, tenantId));
    const byName = allAgents.find(a => `${a.firstName ?? ''} ${a.lastName ?? ''}`.trim() === targetName);
    targetId = byName?.id ?? allAgents.find(a => a.sipUsername === targetName)?.id ?? null;
  }
  return { routeType: typeRaw === 'team' ? 'queue' : typeRaw, routeTargetId: targetId };
}

const byocSchema = z.object({
  name: z.string().min(1),
  host: z.string().min(1),
  port: z.coerce.number().int().default(5060),
  transport: z.enum(['UDP', 'TCP', 'TLS']).default('UDP'),
  codec: z.string().default('G.711'),
  username: z.string().nullable().optional(),
  password: z.string().nullable().optional(),
  maxChannels: z.coerce.number().int().default(50),
  ratePerMinute: z.union([z.number(), z.string()]).transform(String).optional(),
});

// List DIDs
router.get('/', async (c) => {
  const tenantId = c.get('tenantId')!;

  const { cacheGet, cacheSet } = await import('../../lib/redis');
  const cacheKey = `dids:${tenantId}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return c.json(cached);

  const raw = paginationSchema.extend({
    active: z.coerce.boolean().optional(),
    didGroupId: optionalUuid(),
  }).passthrough().parse(c.req.query());
  const { offset, limit } = paginate(raw);

  const conditions: any[] = [eq(dids.tenantId, tenantId)];
  if (raw.search) conditions.push(like(dids.number, `%${raw.search}%`));
  if (raw.active !== undefined) conditions.push(eq(dids.active, raw.active));
  if (raw.didGroupId) conditions.push(eq(dids.didGroupId, raw.didGroupId));
  const where = and(...conditions);

  const [tenantDids, [{ tenantTotal }]] = await Promise.all([
    db.select().from(dids).where(where).orderBy(desc(dids.createdAt)).limit(limit).offset(offset),
    db.select({ tenantTotal: count() }).from(dids).where(where),
  ]);

  // Also include platform DIDs assigned to this tenant — but exclude ones that already have a tenant DID record
  const linkedPlatformDidIds = new Set(tenantDids.filter((d) => d.platformDidId).map((d) => d.platformDidId));
  const assignedPlatformDids = (await db.select().from(platformDids)
    .where(and(eq(platformDids.tenantId, tenantId), eq(platformDids.status, 'assigned'))))
    .filter((pd) => !linkedPlatformDidIds.has(pd.id));

  // Merge: convert platform DIDs to tenant DID shape
  const platformAsDids = assignedPlatformDids.map((pd) => ({
    id: pd.id,
    tenantId,
    platformDidId: pd.id,
    number: pd.number,
    description: `Platform DID (${pd.provider})`,
    country: pd.country,
    city: pd.city,
    state: pd.state,
    didType: pd.didType,
    active: true,
    monthlyCost: pd.monthlyCost,
    createdAt: pd.createdAt,
    source: 'platform' as const,
  }));

  // Build group name lookup from tenant groups + platform groups
  const tenantGroups = await db.select({ id: didGroups.id, name: didGroups.name }).from(didGroups)
    .where(eq(didGroups.tenantId, tenantId));
  const platGroups = await db.select({ id: platformDidGroups.id, name: platformDidGroups.name }).from(platformDidGroups);
  const groupMap = new Map([...tenantGroups, ...platGroups].map((g) => [g.id, g.name]));

  // Build route-target name lookups for IVR / Queue / Team / Agent so the
  // enriched DID rows can carry a display-ready `route` string ("IVR: Main").
  const targetIds = tenantDids.map(d => d.routeTargetId).filter((id): id is string => !!id);
  const [ivrRows, queueRows, teamRows, agentRows] = targetIds.length > 0 ? await Promise.all([
    db.select({ id: ivrMenus.id, name: ivrMenus.name }).from(ivrMenus).where(and(eq(ivrMenus.tenantId, tenantId), inArray(ivrMenus.id, targetIds))),
    db.select({ id: queues.id, name: queues.name }).from(queues).where(and(eq(queues.tenantId, tenantId), inArray(queues.id, targetIds))),
    db.select({ id: teams.id, name: teams.name }).from(teams).where(and(eq(teams.tenantId, tenantId), inArray(teams.id, targetIds))),
    db.select({ id: users.id, firstName: users.firstName, lastName: users.lastName, sipUsername: users.sipUsername }).from(users).where(and(eq(users.tenantId, tenantId), inArray(users.id, targetIds))),
  ]) : [[], [], [], []];
  const targetNameMap = new Map<string, string>();
  for (const r of ivrRows) targetNameMap.set(r.id, r.name);
  for (const r of queueRows) targetNameMap.set(r.id, r.name);
  for (const r of teamRows) targetNameMap.set(r.id, r.name);
  // Match the FE Agent dropdown option format: "First Last" (falls back to
  // sipUsername only when no name set). Mismatch = select shows blank.
  for (const r of agentRows) {
    const name = `${r.firstName ?? ''} ${r.lastName ?? ''}`.trim();
    targetNameMap.set(r.id, name || r.sipUsername || r.id);
  }

  function buildRouteString(routeType: string | null, routeTargetId: string | null): string {
    if (!routeType || routeType === 'none') return 'None';
    if (routeType === 'voicemail') return 'Voicemail';
    if (routeType === 'external') return 'External';
    const label = routeType === 'ivr' ? 'IVR' : routeType === 'queue' ? 'Queue' : routeType === 'agent' ? 'Agent' : routeType;
    const targetName = routeTargetId ? targetNameMap.get(routeTargetId) : null;
    return targetName ? `${label}: ${targetName}` : label;
  }

  // Enrich with group name + display-ready route string
  const enrichedTenant = tenantDids.map((d) => ({
    ...d,
    group: d.didGroupId ? groupMap.get(d.didGroupId) ?? null : null,
    route: buildRouteString(d.routeType, d.routeTargetId),
  }));
  const enrichedPlatform = platformAsDids.map((pd) => {
    const origDid = assignedPlatformDids.find((d) => d.id === pd.id);
    return {
      ...pd,
      didGroupId: origDid?.groupId ?? null,
      group: origDid?.groupId ? groupMap.get(origDid.groupId) ?? null : null,
    };
  });

  const allRows = [...enrichedTenant, ...enrichedPlatform];
  const total = Number(tenantTotal) + assignedPlatformDids.length;

  const result = paginatedResponse(allRows, total, raw);
  await cacheSet(cacheKey, result, 30);
  return c.json(result);
});

// Named routes must be before /:id to avoid route shadowing
router.get('/available', async (c) => {
  const raw = paginationSchema.parse(c.req.query());
  const { offset, limit } = paginate(raw);
  const rows = await db.select().from(platformDids)
    .where(eq(platformDids.status, 'available'))
    .orderBy(desc(platformDids.createdAt)).limit(limit).offset(offset);

  // Map to frontend AvailableNumber shape
  const mapped = rows.map((r) => ({
    id: r.id,
    number: r.number,
    country: r.country ?? 'US',
    city: r.city ?? '',
    state: r.state ?? '',
    type: r.didType ?? 'local',
    cost: Number(r.monthlyCost ?? 0),
    inboundRate: 0,
    outboundRate: 0,
    rateCardName: 'Standard',
    provider: r.provider,
  }));

  return c.json({ data: mapped });
});

// Purchase a platform DID
router.post('/purchase', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = z.object({
    numberId: z.string().uuid(),
    description: z.string().optional(),
    group: z.string().optional(),
    route: z.string().optional(),
    byocCarrierId: z.string().nullable().optional(),
  }).parse(await c.req.json());

  // Mark platform DID as assigned
  const [pDid] = await db.update(platformDids)
    .set({ tenantId, status: 'assigned' })
    .where(and(eq(platformDids.id, body.numberId), eq(platformDids.status, 'available')))
    .returning();
  if (!pDid) throw new NotFound('DID not available');

  // Create tenant DID record
  const [row] = await db.insert(dids).values({
    tenantId,
    platformDidId: pDid.id,
    number: pDid.number,
    description: body.description || `Purchased DID`,
    country: pDid.country || 'US',
    didType: pDid.didType || 'local',
    routeType: body.route || 'ivr',
    active: true,
  }).returning();

  return c.json(row, 201);
});

// Bulk move DIDs to a group. `group` is either a did_group_id (UUID) or
// empty/null to un-group. The previous heuristic (length > 10 → UUID) silently
// dropped names like "CALLERID" (8 chars) and broke UI moves.
router.post('/bulk/move', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = z.object({
    ids: z.array(z.string().uuid()),
    group: z.string().nullable().optional(),
  }).parse(await c.req.json());

  let groupId: string | null = null;
  if (body.group && body.group.trim()) {
    if (!/^[0-9a-f-]{36}$/i.test(body.group)) {
      throw new BadRequest('group must be a did_group_id (UUID), not a name');
    }
    // Verify the group belongs to this tenant before assigning
    const [grp] = await db.select({ id: didGroups.id }).from(didGroups)
      .where(and(eq(didGroups.id, body.group), eq(didGroups.tenantId, tenantId)));
    if (!grp) throw new NotFound('DID group not found');
    groupId = body.group;
  }

  const updated = await db.update(dids)
    .set({ didGroupId: groupId })
    .where(and(inArray(dids.id, body.ids), eq(dids.tenantId, tenantId)))
    .returning({ id: dids.id });

  return c.json({ ok: true, updated: updated.length });
});

// Bulk delete DIDs
router.post('/bulk/delete', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = z.object({ ids: z.array(z.string().uuid()) }).parse(await c.req.json());

  // Remove FK references before deleting
  await db.delete(agentDids).where(inArray(agentDids.didId, body.ids));
  await db.delete(stirDidAttestations).where(inArray(stirDidAttestations.didId, body.ids));

  // Delete tenant-owned DIDs
  const deleted = await db.delete(dids)
    .where(and(inArray(dids.id, body.ids), eq(dids.tenantId, tenantId)))
    .returning({ id: dids.id });

  // Unassign platform DIDs (release back to available)
  const released = await db.update(platformDids)
    .set({ tenantId: null, status: 'available', groupId: null })
    .where(and(inArray(platformDids.id, body.ids), eq(platformDids.tenantId, tenantId)))
    .returning({ id: platformDids.id });

  // Invalidate cache
  const { cacheDelPattern } = await import('../../lib/redis');
  await cacheDelPattern(`dids:${tenantId}*`);

  return c.json({ ok: true, deleted: deleted.length + released.length });
});

// Bulk route DIDs
router.post('/bulk/route', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = z.object({
    ids: z.array(z.string().uuid()),
    route: z.string(),
    unknownCallerRoute: z.string().optional(),
    repeatCallerRoute: z.string().optional(),
    repeatCallerMaxCalls: z.coerce.number().int().optional(),
  }).parse(await c.req.json());

  const resolved = await resolveRoute(body.route, tenantId);
  await db.update(dids)
    .set({
      routeType: resolved?.routeType ?? 'none',
      routeTargetId: resolved?.routeTargetId ?? null,
      unknownCallerRoute: body.unknownCallerRoute,
      repeatCallerRoute: body.repeatCallerRoute,
    })
    .where(and(inArray(dids.id, body.ids), eq(dids.tenantId, tenantId)));

  return c.json({ ok: true, updated: body.ids.length });
});

// Bulk route DID groups
router.post('/groups/bulk/route', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = z.object({
    groupIds: z.array(z.string().uuid()),
    route: z.string(),
    unknownCallerRoute: z.string().optional(),
    repeatCallerRoute: z.string().optional(),
    repeatCallerMaxCalls: z.coerce.number().int().optional(),
  }).parse(await c.req.json());

  await db.update(didGroups)
    .set({ defaultRoute: body.route })
    .where(and(inArray(didGroups.id, body.groupIds), eq(didGroups.tenantId, tenantId)));

  return c.json({ ok: true, updated: body.groupIds.length });
});

// Platform-assigned DID groups for this tenant
router.get('/groups/platform', async (c) => {
  const tenantId = c.get('tenantId')!;

  const groups = await db.select().from(platformDidGroups)
    .where(eq(platformDidGroups.assignedTenantId, tenantId))
    .orderBy(desc(platformDidGroups.createdAt));

  const enriched = await Promise.all(groups.map(async (g) => {
    const groupDids = await db.select({
      number: platformDids.number,
      country: platformDids.country,
      city: platformDids.city,
      type: platformDids.didType,
      cost: platformDids.monthlyCost,
    }).from(platformDids).where(eq(platformDids.groupId, g.id));

    const totalMonthlyCost = groupDids.reduce((sum, d) => sum + Number(d.cost ?? 0), 0);
    // Check assignment status based on whether DIDs are assigned to this tenant
    const [{ assignedCount }] = await db.select({ assignedCount: count() }).from(platformDids)
      .where(and(eq(platformDids.groupId, g.id), eq(platformDids.tenantId, tenantId), eq(platformDids.status, 'assigned')));

    return {
      id: g.id,
      name: g.name,
      description: g.description ?? '',
      didCount: groupDids.length,
      totalMonthlyCost,
      assignmentStatus: Number(assignedCount) > 0 ? 'accepted' as const : 'pending' as const,
      dids: groupDids.map((d) => ({
        number: d.number,
        country: d.country ?? 'US',
        city: d.city ?? '',
        type: d.type ?? 'local',
        cost: Number(d.cost ?? 0),
      })),
      assignedAt: g.createdAt?.toISOString() ?? '',
    };
  }));

  return c.json({ data: enriched });
});

// DID Groups sub-routes — returns tenant's own groups + accepted platform groups
router.get('/groups', async (c) => {
  const tenantId = c.get('tenantId')!;
  // Tenant's own groups
  const ownGroups = await db.select().from(didGroups)
    .where(eq(didGroups.tenantId, tenantId)).orderBy(desc(didGroups.createdAt));

  // Platform groups assigned and accepted by this tenant
  const assignedGroups = await db.select().from(platformDidGroups)
    .where(eq(platformDidGroups.assignedTenantId, tenantId));

  // Check which platform groups have accepted DIDs
  const platformRows = await Promise.all(assignedGroups.map(async (g) => {
    const [{ assignedCount }] = await db.select({ assignedCount: count() }).from(platformDids)
      .where(and(eq(platformDids.groupId, g.id), eq(platformDids.tenantId, tenantId), eq(platformDids.status, 'assigned')));
    if (Number(assignedCount) === 0) return null; // Only include accepted groups
    return {
      id: g.id,
      tenantId,
      name: `${g.name} (Platform)`,
      description: g.description,
      strategy: 'round_robin' as const,
      defaultRoute: null,
      callerIdStrategy: 'fixed' as const,
      createdAt: g.createdAt,
    };
  }));

  const allGroups = [...ownGroups, ...platformRows.filter(Boolean)];
  return c.json({ data: allGroups });
});

router.post('/groups', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = didGroupSchema.parse(await c.req.json());
  const [dup] = await db.select({ id: didGroups.id }).from(didGroups)
    .where(and(eq(didGroups.name, body.name), eq(didGroups.tenantId, tenantId)));
  if (dup) throw new BadRequest('DID group name already exists');
  const [row] = await db.insert(didGroups).values({ ...body, tenantId }).returning();
  return c.json(row, 201);
});

router.put('/groups/:gid', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = didGroupSchema.partial().parse(await c.req.json());
  if (body.name) {
    const [dup] = await db.select({ id: didGroups.id }).from(didGroups)
      .where(and(eq(didGroups.name, body.name), eq(didGroups.tenantId, tenantId), sql`${didGroups.id} != ${c.req.param('gid')}`));
    if (dup) throw new BadRequest('DID group name already exists');
  }
  const [row] = await db.update(didGroups).set(body)
    .where(and(eq(didGroups.id, c.req.param('gid')), eq(didGroups.tenantId, tenantId)))
    .returning();
  if (!row) throw new NotFound('DID group not found');
  return c.json(row);
});

router.delete('/groups/:gid', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const [row] = await db.delete(didGroups)
    .where(and(eq(didGroups.id, c.req.param('gid')), eq(didGroups.tenantId, tenantId)))
    .returning();
  if (!row) throw new NotFound('DID group not found');
  return c.json({ ok: true });
});

// Accept platform-assigned DID group
router.post('/groups/:gid/accept', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const groupId = c.req.param('gid');
  // Verify this group is actually assigned to this tenant
  const [group] = await db.select().from(platformDidGroups)
    .where(and(eq(platformDidGroups.id, groupId), eq(platformDidGroups.assignedTenantId, tenantId)));
  if (!group) throw new NotFound('Group not found or not assigned to you');
  // Mark all DIDs in this group as assigned to this tenant
  const accepted = await db.update(platformDids)
    .set({ status: 'assigned', tenantId })
    .where(eq(platformDids.groupId, groupId))
    .returning();

  // Materialize tenant `dids` rows so the dialer (and bulk/move, etc.) can see
  // them. Skip rows we've already linked. This keeps the tenant-side dids
  // table as the single source of truth for the dialer.
  if (accepted.length > 0) {
    const ids = accepted.map((p) => p.id);
    const existing = await db.select({ platformDidId: dids.platformDidId }).from(dids)
      .where(and(eq(dids.tenantId, tenantId), inArray(dids.platformDidId, ids)));
    const linked = new Set(existing.map((e) => e.platformDidId));
    const toInsert = accepted.filter((p) => !linked.has(p.id)).map((p) => ({
      tenantId,
      platformDidId: p.id,
      number: p.number,
      country: p.country ?? 'US',
      city: p.city,
      state: p.state,
      didType: (p.didType as 'local' | 'tollfree' | 'international') ?? 'local',
      active: true,
      routeType: 'ivr',
      description: `Platform DID (${p.provider ?? 'unspecified'})`,
    }));
    if (toInsert.length > 0) await db.insert(dids).values(toInsert);
  }
  return c.json({ ok: true, materialized: accepted.length });
});

// Decline platform-assigned DID group
router.post('/groups/:gid/decline', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const groupId = c.req.param('gid');
  // Clear the assignment on the group
  await db.update(platformDidGroups)
    .set({ assignedTenantId: null })
    .where(and(eq(platformDidGroups.id, groupId), eq(platformDidGroups.assignedTenantId, tenantId)));
  // Release any DIDs that were assigned
  const released = await db.update(platformDids)
    .set({ status: 'available', tenantId: null })
    .where(and(eq(platformDids.groupId, groupId), eq(platformDids.tenantId, tenantId)))
    .returning({ id: platformDids.id });

  // Drop matching tenant `dids` rows so the dialer stops using them
  if (released.length > 0) {
    const ids = released.map((r) => r.id);
    await db.delete(agentDids).where(inArray(agentDids.didId,
      (await db.select({ id: dids.id }).from(dids).where(inArray(dids.platformDidId, ids))).map((d) => d.id)));
    await db.delete(dids).where(and(eq(dids.tenantId, tenantId), inArray(dids.platformDidId, ids)));
  }
  return c.json({ ok: true });
});

// Release/revoke an accepted platform-assigned DID group (tenant side)
router.post('/groups/:gid/release', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const groupId = c.req.param('gid');
  // Clear DIDs (release back to the platform pool)
  const released = await db.update(platformDids)
    .set({ status: 'available', tenantId: null })
    .where(and(eq(platformDids.groupId, groupId), eq(platformDids.tenantId, tenantId)))
    .returning({ id: platformDids.id });
  // Drop matching tenant `dids` rows so they stop appearing on the tenant page
  if (released.length > 0) {
    const ids = released.map((r) => r.id);
    const linkedDidIds = (await db.select({ id: dids.id }).from(dids)
      .where(and(eq(dids.tenantId, tenantId), inArray(dids.platformDidId, ids)))).map((d) => d.id);
    if (linkedDidIds.length > 0) {
      await db.delete(agentDids).where(inArray(agentDids.didId, linkedDidIds));
      await db.delete(dids).where(inArray(dids.id, linkedDidIds));
    }
  }
  // Clear group assignment
  await db.update(platformDidGroups)
    .set({ assignedTenantId: null })
    .where(and(eq(platformDidGroups.id, groupId), eq(platformDidGroups.assignedTenantId, tenantId)));
  return c.json({ ok: true });
});

// BYOC carriers sub-routes
router.get('/byoc', async (c) => {
  const tenantId = c.get('tenantId')!;
  const rows = await db.select({
    id: byocCarriers.id,
    name: byocCarriers.name,
    host: byocCarriers.host,
    port: byocCarriers.port,
    transport: byocCarriers.transport,
    codec: byocCarriers.codec,
    username: byocCarriers.username,
    maxChannels: byocCarriers.maxChannels,
    ratePerMinute: byocCarriers.ratePerMinute,
    status: byocCarriers.status,
    registered: byocCarriers.registered,
    createdAt: byocCarriers.createdAt,
  }).from(byocCarriers).where(eq(byocCarriers.tenantId, tenantId)).orderBy(desc(byocCarriers.createdAt));
  return c.json({ data: rows });
});

router.post('/byoc', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = byocSchema.parse(await c.req.json());
  const [dup] = await db.select({ id: byocCarriers.id }).from(byocCarriers)
    .where(and(eq(byocCarriers.name, body.name), eq(byocCarriers.tenantId, tenantId)));
  if (dup) throw new BadRequest('BYOC carrier name already exists');
  const { password, ...rest } = body;
  const { hashPassword } = await import('../../lib/password');
  const passwordHash = password ? await hashPassword(password) : undefined;
  const [row] = await db.insert(byocCarriers).values({ ...rest, tenantId, ...(passwordHash ? { passwordHash } : {}) }).returning();
  return c.json(row, 201);
});

router.put('/byoc/:bid', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = byocSchema.partial().parse(await c.req.json());
  if (body.name) {
    const [dup] = await db.select({ id: byocCarriers.id }).from(byocCarriers)
      .where(and(eq(byocCarriers.name, body.name), eq(byocCarriers.tenantId, tenantId), sql`${byocCarriers.id} != ${c.req.param('bid')}`));
    if (dup) throw new BadRequest('BYOC carrier name already exists');
  }
  const { password, ...rest } = body;
  const { hashPassword } = await import('../../lib/password');
  const passwordHash = password ? await hashPassword(password) : undefined;
  const [row] = await db.update(byocCarriers)
    .set({ ...rest, ...(passwordHash ? { passwordHash } : {}) })
    .where(and(eq(byocCarriers.id, c.req.param('bid')), eq(byocCarriers.tenantId, tenantId)))
    .returning();
  if (!row) throw new NotFound('BYOC carrier not found');
  return c.json(row);
});

router.delete('/byoc/:bid', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const [row] = await db.delete(byocCarriers)
    .where(and(eq(byocCarriers.id, c.req.param('bid')), eq(byocCarriers.tenantId, tenantId)))
    .returning();
  if (!row) throw new NotFound('BYOC carrier not found');
  return c.json({ ok: true });
});

router.get('/:id', async (c) => {
  const tenantId = c.get('tenantId')!;
  const didId = c.req.param('id');

  // Try tenant DID first
  const [row] = await db.select().from(dids)
    .where(and(eq(dids.id, didId), eq(dids.tenantId, tenantId)));
  if (row) return c.json(row);

  // Try platform DID assigned to this tenant
  const [pDid] = await db.select().from(platformDids)
    .where(and(eq(platformDids.id, didId), eq(platformDids.tenantId, tenantId)));
  if (pDid) return c.json(pDid);

  throw new NotFound('DID not found');
});

router.post('/', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = didSchema.parse(await c.req.json());
  const [row] = await db.insert(dids).values({ ...body, tenantId }).returning();
  const { cacheDelPattern } = await import('../../lib/redis');
  await cacheDelPattern(`dids:${tenantId}*`);
  // Refresh inbound dialplan (best-effort, runs async)
  try {
    const cmds = await import('../../esl/commands');
    void cmds.syncInboundDidDialplan();
    // DID change ⇒ tenant default outbound caller-id may have moved → re-push every agent's directory entry.
    void cmds.repushSipUsersForTenant(tenantId);
  } catch {}
  return c.json(row, 201);
});

router.put('/:id', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const didId = c.req.param('id');
  const rawBody = await c.req.json();
  const body = didSchema.partial().omit({ number: true }).passthrough().parse(rawBody);

  // FE sends `route` (combined "Type: Target" string). Resolve to
  // (routeType, routeTargetId) so it can be persisted on the row directly.
  if (typeof rawBody?.route === 'string' && rawBody.route.length > 0) {
    const resolved = await resolveRoute(rawBody.route, tenantId);
    if (resolved) {
      (body as any).routeType = resolved.routeType;
      (body as any).routeTargetId = resolved.routeTargetId;
    }
  }
  // Strip any non-column keys before db.update — Drizzle is lenient but it
  // documents intent that these aren't persisted.
  const { route: _route, routeTarget: _routeTarget, ...persistable } = body as any;

  // Try tenant DID first
  const [row] = await db.update(dids).set(persistable)
    .where(and(eq(dids.id, didId), eq(dids.tenantId, tenantId)))
    .returning();

  if (!row) {
    // Try platform DID — only allow updating routing fields
    const [pDid] = await db.select({ id: platformDids.id }).from(platformDids)
      .where(and(eq(platformDids.id, didId), eq(platformDids.tenantId, tenantId)));
    if (!pDid) throw new NotFound('DID not found');

    // Create a tenant DID record linked to the platform DID for routing
    const [platformDidRow] = await db.select().from(platformDids).where(eq(platformDids.id, didId));
    const [newDid] = await db.insert(dids).values({
      tenantId,
      platformDidId: didId,
      number: platformDidRow.number,
      country: platformDidRow.country || 'US',
      didType: platformDidRow.didType || 'local',
      routeType: body.routeType || 'ivr',
      routeTargetId: body.routeTargetId || null,
      active: true,
      ...body,
    }).onConflictDoNothing().returning();

    if (newDid) {
      const { cacheDelPattern } = await import('../../lib/redis');
      await cacheDelPattern(`dids:${tenantId}*`);
      return c.json(newDid);
    }
  }

  const { cacheDelPattern } = await import('../../lib/redis');
  await cacheDelPattern(`dids:${tenantId}*`);
  try {
    const cmds = await import('../../esl/commands');
    void cmds.syncInboundDidDialplan();
    // DID change ⇒ tenant default outbound caller-id may have moved → re-push every agent's directory entry.
    void cmds.repushSipUsersForTenant(tenantId);
  } catch {}
  return c.json(row);
});

router.delete('/:id', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const didId = c.req.param('id');

  // Remove FK references before deleting
  await db.delete(agentDids).where(eq(agentDids.didId, didId));
  await db.delete(stirDidAttestations).where(eq(stirDidAttestations.didId, didId));

  // Try tenant DID first
  const [row] = await db.delete(dids)
    .where(and(eq(dids.id, didId), eq(dids.tenantId, tenantId)))
    .returning();

  // If not a tenant DID, try releasing a platform DID
  if (!row) {
    const [released] = await db.update(platformDids)
      .set({ tenantId: null, status: 'available', groupId: null })
      .where(and(eq(platformDids.id, didId), eq(platformDids.tenantId, tenantId)))
      .returning();
    if (!released) throw new NotFound('DID not found');
  }

  const { cacheDelPattern } = await import('../../lib/redis');
  await cacheDelPattern(`dids:${tenantId}*`);
  try {
    const cmds = await import('../../esl/commands');
    void cmds.syncInboundDidDialplan();
    // DID change ⇒ tenant default outbound caller-id may have moved → re-push every agent's directory entry.
    void cmds.repushSipUsersForTenant(tenantId);
  } catch {}
  return c.json({ ok: true });
});

export default router;
