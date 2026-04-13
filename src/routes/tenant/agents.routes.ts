import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, like, desc, count, inArray, isNull } from 'drizzle-orm';
import { db } from '../../db/client';
import { users, skills, agentSkills } from '../../db/schema';
import { paginationSchema, paginate, paginatedResponse } from '../../lib/pagination';
import { NotFound, BadRequest } from '../../lib/errors';
import { requireRole } from '../../middleware/roles';

const router = new Hono();

const agentSchema = z.object({
  email: z.string().email(),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  role: z.enum(['agent', 'supervisor', 'tenant_admin']),
  teamId: z.string().uuid().nullable().optional(),
  status: z.string().optional(),
  settings: z.record(z.unknown()).optional(),
});

const updateAgentSchema = agentSchema.partial().omit({ email: true });

// Named routes before /:id
router.post('/import', requireRole('tenant_admin'), async (c) => {
  return c.json({ ok: true, message: 'Import queued' }, 202);
});

// List agents
router.get('/', async (c) => {
  const tenantId = c.get('tenantId')!;
  const raw = paginationSchema.extend({
    role: z.string().optional(),
    status: z.string().optional(),
    teamId: z.string().uuid().optional(),
  }).parse(c.req.query());
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

  return c.json(paginatedResponse(rows, Number(total), raw));
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
  const { hashPassword } = await import('../../lib/password');
  const tempPass = Math.random().toString(36).slice(-10);
  const passwordHash = await hashPassword(tempPass);
  const [row] = await db.insert(users).values({ ...body, tenantId, passwordHash }).returning();
  return c.json({ ...row, tempPassword: tempPass }, 201);
});

// Update agent
router.put('/:id', requireRole('tenant_admin', 'supervisor'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = updateAgentSchema.parse(await c.req.json());
  const [row] = await db.update(users)
    .set({ ...body, updatedAt: new Date() })
    .where(and(eq(users.id, c.req.param('id')), eq(users.tenantId, tenantId), isNull(users.deletedAt)))
    .returning();
  if (!row) throw new NotFound('Agent not found');
  return c.json(row);
});

// Delete agent
router.delete('/:id', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const [row] = await db.update(users)
    .set({ deletedAt: new Date() })
    .where(and(eq(users.id, c.req.param('id')), eq(users.tenantId, tenantId), isNull(users.deletedAt)))
    .returning();
  if (!row) throw new NotFound('Agent not found');
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

  return c.json(rows);
});

// Assign skills to agent
router.put('/:id/skills', requireRole('tenant_admin', 'supervisor'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = z.object({
    skills: z.array(z.object({ skillId: z.string().uuid(), proficiency: z.number().int().min(1).max(5).default(1) })),
  }).parse(await c.req.json());

  const [agent] = await db.select({ id: users.id }).from(users)
    .where(and(eq(users.id, c.req.param('id')), eq(users.tenantId, tenantId), isNull(users.deletedAt)));
  if (!agent) throw new NotFound('Agent not found');

  await db.delete(agentSkills).where(eq(agentSkills.agentId, agent.id));
  if (body.skills.length) {
    await db.insert(agentSkills).values(body.skills.map((s) => ({ agentId: agent.id, skillId: s.skillId, proficiency: s.proficiency })));
  }
  return c.json({ ok: true });
});

// Regenerate SIP credentials - placeholder
router.post('/:id/regenerate-sip', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const [agent] = await db.select({ id: users.id }).from(users)
    .where(and(eq(users.id, c.req.param('id')), eq(users.tenantId, tenantId), isNull(users.deletedAt)));
  if (!agent) throw new NotFound('Agent not found');
  return c.json({ ok: true, message: 'SIP credentials regeneration queued' }, 202);
});

export default router;
