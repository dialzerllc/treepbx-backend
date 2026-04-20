import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, like, desc, count, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../../db/client';
import { users, skills, agentSkills, agentDids, dids, agentLeadLists, leadLists } from '../../db/schema';
import { paginationSchema, paginate, paginatedResponse } from '../../lib/pagination';
import { NotFound, BadRequest } from '../../lib/errors';
import { requireRole } from '../../middleware/roles';
import { optionalUuid } from '../../lib/zod-helpers';

const router = new Hono();

const sipUsernameSchema = z.string().max(4, 'Extension must be at most 4 digits').regex(/^\d{1,4}$/, 'Extension must be 1-4 digits').nullable().optional();

const agentSchema = z.object({
  email: z.string().email(),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  role: z.enum(['agent', 'supervisor', 'tenant_admin']),
  teamId: z.string().nullable().optional().transform((v) => v && /^[0-9a-f-]{36}$/i.test(v) ? v : null),
  status: z.string().nullable().optional(),
  sipUsername: sipUsernameSchema,
  sipDomain: z.string().nullable().optional(),
  settings: z.record(z.unknown()).optional(),
  password: z.string().min(6).optional(),
});

async function checkDuplicateExtension(sipUsername: string | null | undefined, tenantId: string, excludeUserId?: string) {
  if (!sipUsername) return;
  const conditions = [eq(users.sipUsername, sipUsername), eq(users.tenantId, tenantId), isNull(users.deletedAt)];
  if (excludeUserId) conditions.push(sql`${users.id} != ${excludeUserId}`);
  const [dup] = await db.select({ id: users.id }).from(users).where(and(...conditions));
  if (dup) throw new BadRequest('Extension already in use');
}

const updateAgentSchema = agentSchema.partial().omit({ email: true, password: true });

// Bulk import agents
router.post('/import', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = z.object({
    agents: z.array(z.object({
      firstName: z.string().min(1),
      lastName: z.string().min(1),
      email: z.string().email(),
      role: z.enum(['agent', 'supervisor', 'tenant_admin']).default('agent'),
      teamId: z.string().nullable().optional().transform((v) => v && /^[0-9a-f-]{36}$/i.test(v) ? v : null),
      sipUsername: sipUsernameSchema,
      sipDomain: z.string().nullable().optional(),
      password: z.string().min(6).optional(),
    })),
  }).parse(await c.req.json());

  const { hashPassword } = await import('../../lib/password');

  let created = 0;
  let skipped = 0;
  const results: { email: string; tempPassword?: string }[] = [];
  const batchSize = 50;

  for (let i = 0; i < body.agents.length; i += batchSize) {
    const batch = body.agents.slice(i, i + batchSize);
    for (const agent of batch) {
      try {
        // Check duplicate email (globally unique)
        const [existing] = await db.select({ id: users.id }).from(users)
          .where(eq(users.email, agent.email));
        if (existing) { skipped++; continue; }

        // Check duplicate extension within tenant
        if (agent.sipUsername) {
          const [dupExt] = await db.select({ id: users.id }).from(users)
            .where(and(eq(users.sipUsername, agent.sipUsername), eq(users.tenantId, tenantId), isNull(users.deletedAt)));
          if (dupExt) { skipped++; continue; }
        }

        const tempPass = agent.password || Math.random().toString(36).slice(-10);
        const passwordHash = await hashPassword(tempPass);
        const { password: _, ...insertData } = agent;

        await db.insert(users).values({
          ...insertData,
          tenantId,
          passwordHash,
        });
        created++;
        if (!agent.password) {
          results.push({ email: agent.email, tempPassword: tempPass });
        }
      } catch {
        skipped++;
      }
    }
  }

  const { cacheDelPattern } = await import('../../lib/redis');
  await cacheDelPattern(`agents:${tenantId}*`);

  return c.json({ ok: true, created, skipped, credentials: results });
});

// List agents
router.get('/', async (c) => {
  const tenantId = c.get('tenantId')!;

  const { cacheGet, cacheSet } = await import('../../lib/redis');
  const cacheKey = `agents:${tenantId}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return c.json(cached);

  const raw = paginationSchema.extend({
    role: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
    teamId: optionalUuid(),
  }).passthrough().parse(c.req.query());
  const { offset, limit } = paginate(raw);

  const conditions: any[] = [
    eq(users.tenantId, tenantId),
    inArray(users.role, ['agent', 'supervisor', 'tenant_admin']),
    isNull(users.deletedAt),
  ];
  if (raw.search) conditions.push(like(users.firstName, `%${raw.search}%`));
  if (raw.role) conditions.push(eq(users.role, raw.role));
  if (raw.status) conditions.push(eq(users.status, raw.status));
  if (raw.teamId) conditions.push(eq(users.teamId, raw.teamId));

  const where = and(...conditions);
  const [rows, [{ total }]] = await Promise.all([
    db.select({
      id: users.id,
      tenantId: users.tenantId,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      role: users.role,
      status: users.status,
      teamId: users.teamId,
      sipUsername: users.sipUsername,
      sipDomain: users.sipDomain,
      lastLoginAt: users.lastLoginAt,
      createdAt: users.createdAt,
    }).from(users).where(where).orderBy(desc(users.createdAt)).limit(limit).offset(offset),
    db.select({ total: count() }).from(users).where(where),
  ]);

  // Enrich with skills per agent
  const agentIds = rows.map((r) => r.id);
  const allAgentSkills = agentIds.length > 0
    ? await db.select({
        agentId: agentSkills.agentId,
        skillId: agentSkills.skillId,
        proficiency: agentSkills.proficiency,
        name: skills.name,
      }).from(agentSkills)
        .innerJoin(skills, eq(agentSkills.skillId, skills.id))
        .where(inArray(agentSkills.agentId, agentIds))
    : [];

  const enriched = rows.map((r) => ({
    ...r,
    skills: allAgentSkills.filter((s) => s.agentId === r.id),
  }));

  const result = paginatedResponse(enriched, Number(total), raw);
  await cacheSet(cacheKey, result, 15);
  return c.json(result);
});

// Get single agent
router.get('/:id', async (c) => {
  const tenantId = c.get('tenantId')!;
  const [row] = await db.select({
    id: users.id,
    tenantId: users.tenantId,
    email: users.email,
    firstName: users.firstName,
    lastName: users.lastName,
    role: users.role,
    status: users.status,
    teamId: users.teamId,
    sipUsername: users.sipUsername,
    sipDomain: users.sipDomain,
    settings: users.settings,
    permissions: users.permissions,
    lastLoginAt: users.lastLoginAt,
    createdAt: users.createdAt,
  }).from(users).where(and(eq(users.id, c.req.param('id')), eq(users.tenantId, tenantId), isNull(users.deletedAt)));
  if (!row) throw new NotFound('Agent not found');

  const agentSkillRows = await db.select({
    skillId: agentSkills.skillId,
    proficiency: agentSkills.proficiency,
    name: skills.name,
  }).from(agentSkills)
    .innerJoin(skills, eq(agentSkills.skillId, skills.id))
    .where(eq(agentSkills.agentId, row.id));

  return c.json({ ...row, skills: agentSkillRows });
});

// Create agent (tenant_admin only)
router.post('/', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = agentSchema.parse(await c.req.json());

  // Check for duplicate email (globally unique constraint)
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, body.email));
  if (existing) throw new BadRequest('Email already exists');

  // Check for duplicate extension within tenant
  await checkDuplicateExtension(body.sipUsername, tenantId);

  const { hashPassword } = await import('../../lib/password');
  const customPass = body.password;
  const tempPass = customPass || Math.random().toString(36).slice(-10);
  const passwordHash = await hashPassword(tempPass);
  const { password: _, ...insertData } = body;
  const [row] = await db.insert(users).values({ ...insertData, tenantId, passwordHash }).returning();
  const { cacheDelPattern } = await import('../../lib/redis');
  await cacheDelPattern(`agents:${tenantId}*`);
  return c.json({ ...row, tempPassword: customPass ? undefined : tempPass }, 201);
});

// Update agent
router.put('/:id', requireRole('tenant_admin', 'supervisor'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const raw = await c.req.json();
  const body = updateAgentSchema.parse(raw);

  // Check for duplicate extension within tenant
  if (body.sipUsername) {
    await checkDuplicateExtension(body.sipUsername, tenantId, c.req.param('id'));
  }

  // Handle password change
  const updates: Record<string, unknown> = { ...body, updatedAt: new Date() };
  if (raw.password && typeof raw.password === 'string' && raw.password.length >= 6) {
    const { hashPassword } = await import('../../lib/password');
    updates.passwordHash = await hashPassword(raw.password);
  }

  const [row] = await db.update(users)
    .set(updates)
    .where(and(eq(users.id, c.req.param('id')), eq(users.tenantId, tenantId), isNull(users.deletedAt)))
    .returning();
  if (!row) throw new NotFound('Agent not found');
  const { cacheDelPattern } = await import('../../lib/redis');
  await cacheDelPattern(`agents:${tenantId}*`);
  return c.json(row);
});

// Bulk delete agents (soft delete)
router.post('/bulk/delete', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = z.object({ ids: z.array(z.string().uuid()) }).parse(await c.req.json());

  const deleted = await db.update(users)
    .set({ deletedAt: new Date() })
    .where(and(inArray(users.id, body.ids), eq(users.tenantId, tenantId), isNull(users.deletedAt)))
    .returning({ id: users.id });

  const { cacheDelPattern } = await import('../../lib/redis');
  await cacheDelPattern(`agents:${tenantId}*`);
  return c.json({ ok: true, deleted: deleted.length });
});

// Delete agent
router.delete('/:id', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const [row] = await db.update(users)
    .set({ deletedAt: new Date() })
    .where(and(eq(users.id, c.req.param('id')), eq(users.tenantId, tenantId), isNull(users.deletedAt)))
    .returning();
  if (!row) throw new NotFound('Agent not found');
  const { cacheDelPattern } = await import('../../lib/redis');
  await cacheDelPattern(`agents:${tenantId}*`);
  return c.json({ ok: true });
});

// Get agent skills
router.get('/:id/skills', async (c) => {
  const tenantId = c.get('tenantId')!;
  const [agent] = await db.select({ id: users.id }).from(users)
    .where(and(eq(users.id, c.req.param('id')), eq(users.tenantId, tenantId), isNull(users.deletedAt)));
  if (!agent) throw new NotFound('Agent not found');

  const rows = await db.select({
    skillId: agentSkills.skillId,
    proficiency: agentSkills.proficiency,
    name: skills.name,
    description: skills.description,
  }).from(agentSkills)
    .innerJoin(skills, eq(agentSkills.skillId, skills.id))
    .where(eq(agentSkills.agentId, agent.id));

  return c.json({ data: rows });
});

// Assign skills to agent
router.put('/:id/skills', requireRole('tenant_admin', 'supervisor'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = z.object({
    skills: z.array(z.object({ skillId: z.string().uuid(), proficiency: z.coerce.number().int().min(1).max(5).default(1) })),
  }).passthrough().parse(await c.req.json());

  const [agent] = await db.select({ id: users.id }).from(users)
    .where(and(eq(users.id, c.req.param('id')), eq(users.tenantId, tenantId), isNull(users.deletedAt)));
  if (!agent) throw new NotFound('Agent not found');

  await db.delete(agentSkills).where(eq(agentSkills.agentId, agent.id));
  if (body.skills.length) {
    await db.insert(agentSkills).values(body.skills.map((s) => ({ agentId: agent.id, skillId: s.skillId, proficiency: s.proficiency })));
  }
  return c.json({ ok: true });
});

// Update agent status
router.put('/:id/status', requireRole('tenant_admin', 'supervisor'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = z.object({ status: z.string().min(1) }).parse(await c.req.json());
  const [row] = await db.update(users)
    .set({ status: body.status, statusChangedAt: new Date() })
    .where(and(eq(users.id, c.req.param('id')), eq(users.tenantId, tenantId), isNull(users.deletedAt)))
    .returning();
  if (!row) throw new NotFound('Agent not found');
  return c.json(row);
});

// Regenerate SIP credentials
router.post('/:id/regenerate-sip', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const { randomBytes } = await import('crypto');
  const sipUsername = `agent_${randomBytes(4).toString('hex')}`;
  const sipPassword = randomBytes(8).toString('base64url');
  const { hashPassword } = await import('../../lib/password');
  const sipPasswordHash = await hashPassword(sipPassword);
  const [row] = await db.update(users)
    .set({ sipUsername, sipPasswordHash, sipDomain: 'sip.treepbx.com', updatedAt: new Date() })
    .where(and(eq(users.id, c.req.param('id')), eq(users.tenantId, tenantId), isNull(users.deletedAt)))
    .returning({ id: users.id, sipUsername: users.sipUsername, sipDomain: users.sipDomain });
  if (!row) throw new NotFound('Agent not found');
  return c.json({ ...row, sipPassword });
});

// Get agent's assigned DIDs
router.get('/:id/dids', async (c) => {
  const tenantId = c.get('tenantId')!;
  const agentId = c.req.param('id');
  const rows = await db.select({
    didId: agentDids.didId,
    number: dids.number,
    country: dids.country,
  }).from(agentDids)
    .innerJoin(dids, eq(agentDids.didId, dids.id))
    .where(eq(agentDids.agentId, agentId));
  return c.json({ data: rows });
});

// Assign DIDs to agent
router.put('/:id/dids', requireRole('tenant_admin', 'supervisor'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const agentId = c.req.param('id');
  const body = z.object({ didIds: z.array(z.string().uuid()) }).parse(await c.req.json());

  // Verify agent belongs to tenant
  const [agent] = await db.select({ id: users.id }).from(users)
    .where(and(eq(users.id, agentId), eq(users.tenantId, tenantId), isNull(users.deletedAt)));
  if (!agent) throw new NotFound('Agent not found');

  // Replace all DID assignments
  await db.delete(agentDids).where(eq(agentDids.agentId, agentId));
  if (body.didIds.length > 0) {
    await db.insert(agentDids).values(body.didIds.map((didId) => ({ agentId, didId })));
  }

  // Invalidate cache
  const { cacheDelPattern } = await import('../../lib/redis');
  await cacheDelPattern(`agents:${tenantId}*`);

  return c.json({ ok: true, assigned: body.didIds.length });
});

// Get agent's assigned lead lists
router.get('/:id/lead-lists', async (c) => {
  const tenantId = c.get('tenantId')!;
  const agentId = c.req.param('id');
  const rows = await db.select({
    leadListId: agentLeadLists.leadListId,
    name: leadLists.name,
    description: leadLists.description,
    leadCount: leadLists.leadCount,
  }).from(agentLeadLists)
    .innerJoin(leadLists, eq(agentLeadLists.leadListId, leadLists.id))
    .where(eq(agentLeadLists.agentId, agentId));
  return c.json({ data: rows });
});

// Assign lead lists to agent
router.put('/:id/lead-lists', requireRole('tenant_admin', 'supervisor'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const agentId = c.req.param('id');
  const body = z.object({ leadListIds: z.array(z.string().uuid()) }).parse(await c.req.json());

  const [agent] = await db.select({ id: users.id }).from(users)
    .where(and(eq(users.id, agentId), eq(users.tenantId, tenantId), isNull(users.deletedAt)));
  if (!agent) throw new NotFound('Agent not found');

  await db.delete(agentLeadLists).where(eq(agentLeadLists.agentId, agentId));
  if (body.leadListIds.length > 0) {
    await db.insert(agentLeadLists).values(body.leadListIds.map((leadListId) => ({ agentId, leadListId })));
  }

  const { cacheDelPattern } = await import('../../lib/redis');
  await cacheDelPattern(`agents:${tenantId}*`);
  return c.json({ ok: true, assigned: body.leadListIds.length });
});

export default router;
