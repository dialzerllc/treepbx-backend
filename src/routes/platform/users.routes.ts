import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, like, desc, count, isNull, or } from 'drizzle-orm';
import { db } from '../../db/client';
import { users } from '../../db/schema';
import { paginationSchema, paginate, paginatedResponse } from '../../lib/pagination';
import { NotFound } from '../../lib/errors';
import { hashPassword } from '../../lib/password';

const router = new Hono();

const createUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  role: z.enum(['super_admin', 'platform_supervisor']),
  permissions: z.record(z.unknown()).default({}),
});

const updateUserSchema = z.object({
  email: z.string().email().optional(),
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  role: z.enum(['super_admin', 'platform_supervisor']).optional(),
  status: z.string().optional(),
  permissions: z.record(z.unknown()).optional(),
  password: z.string().min(8).optional(),
});

router.get('/', async (c) => {
  const raw = paginationSchema.parse(c.req.query());
  const { offset, limit } = paginate(raw);

  const conditions = [isNull(users.tenantId), isNull(users.deletedAt)];
  if (raw.search) {
    conditions.push(
      or(like(users.email, `%${raw.search}%`), like(users.firstName, `%${raw.search}%`), like(users.lastName, `%${raw.search}%`))!
    );
  }
  const where = and(...conditions);

  const [rows, [{ total }]] = await Promise.all([
    db.select({
      id: users.id,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      role: users.role,
      status: users.status,
      lastLoginAt: users.lastLoginAt,
      createdAt: users.createdAt,
    }).from(users).where(where).orderBy(desc(users.createdAt)).limit(limit).offset(offset),
    db.select({ total: count() }).from(users).where(where),
  ]);

  return c.json(paginatedResponse(rows, Number(total), raw));
});

router.get('/:id', async (c) => {
  const [row] = await db.select({
    id: users.id,
    email: users.email,
    firstName: users.firstName,
    lastName: users.lastName,
    role: users.role,
    status: users.status,
    permissions: users.permissions,
    lastLoginAt: users.lastLoginAt,
    createdAt: users.createdAt,
  }).from(users).where(and(eq(users.id, c.req.param('id')), isNull(users.tenantId), isNull(users.deletedAt)));
  if (!row) throw new NotFound('User not found');
  return c.json(row);
});

router.post('/', async (c) => {
  const body = createUserSchema.parse(await c.req.json());
  const { password, ...rest } = body;
  const passwordHash = await hashPassword(password);
  const [row] = await db.insert(users).values({ ...rest, passwordHash, tenantId: null }).returning({
    id: users.id, email: users.email, firstName: users.firstName, lastName: users.lastName,
    role: users.role, createdAt: users.createdAt,
  });
  return c.json(row, 201);
});

router.put('/:id', async (c) => {
  const body = updateUserSchema.parse(await c.req.json());
  const { password, ...rest } = body;
  const update: Record<string, unknown> = { ...rest, updatedAt: new Date() };
  if (password) update.passwordHash = await hashPassword(password);

  const [row] = await db.update(users).set(update)
    .where(and(eq(users.id, c.req.param('id')), isNull(users.tenantId), isNull(users.deletedAt))).returning({
      id: users.id, email: users.email, firstName: users.firstName, lastName: users.lastName,
      role: users.role, status: users.status, updatedAt: users.updatedAt,
    });
  if (!row) throw new NotFound('User not found');
  return c.json(row);
});

router.delete('/:id', async (c) => {
  const [row] = await db.update(users).set({ deletedAt: new Date() })
    .where(and(eq(users.id, c.req.param('id')), isNull(users.tenantId), isNull(users.deletedAt))).returning();
  if (!row) throw new NotFound('User not found');
  return c.json({ ok: true });
});

export default router;
