import { Hono } from 'hono';
import { z } from 'zod';
import { eq, like, desc, count, sql } from 'drizzle-orm';
import { db } from '../../db/client';
import { carriers } from '../../db/schema';
import { paginationSchema, paginate, paginatedResponse } from '../../lib/pagination';
import { NotFound, BadRequest } from '../../lib/errors';

const router = new Hono();

const carrierSchema = z.object({
  name: z.string().min(1),
  host: z.string().min(1),
  port: z.coerce.number().int().default(5060),
  transport: z.enum(['UDP', 'TCP', 'TLS']).default('UDP'),
  direction: z.enum(['inbound', 'outbound', 'both']).default('both'),
  maxChannels: z.coerce.number().int().default(100),
  priority: z.coerce.number().int().min(1).default(1),
  status: z.enum(['active', 'inactive']).default('active'),
  registrationUser: z.string().nullable().optional(),
  registrationPassword: z.string().nullable().optional(),
  registrationExpiry: z.coerce.number().int().default(3600),
});

const updateCarrierSchema = carrierSchema.partial();

router.get('/', async (c) => {
  const raw = paginationSchema.parse(c.req.query());
  const { offset, limit } = paginate(raw);

  const where = raw.search ? like(carriers.name, `%${raw.search}%`) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db.select().from(carriers).where(where).orderBy(desc(carriers.createdAt)).limit(limit).offset(offset),
    db.select({ total: count() }).from(carriers).where(where),
  ]);

  return c.json(paginatedResponse(rows, Number(total), raw));
});

router.get('/:id', async (c) => {
  const [row] = await db.select().from(carriers).where(eq(carriers.id, c.req.param('id')));
  if (!row) throw new NotFound('Carrier not found');
  return c.json(row);
});

router.post('/', async (c) => {
  const raw = await c.req.json();
  const body = carrierSchema.parse(raw);
  const [dup] = await db.select({ id: carriers.id }).from(carriers)
    .where(eq(carriers.name, body.name));
  if (dup) throw new BadRequest('Carrier name already exists');
  const { registrationPassword, ...dbData } = body;
  // Sanitize name for FreeSWITCH gateway compatibility
  dbData.name = dbData.name.replace(/[^a-zA-Z0-9_-]/g, '_');
  const [row] = await db.insert(carriers).values(dbData).returning();

  // Auto-provision FreeSWITCH gateway
  try {
    const { addGateway } = await import('../../esl/commands');
    const ok = await addGateway(row.name, {
      host: row.host, port: row.port ?? 5060, transport: row.transport ?? 'UDP',
      username: body.registrationUser || undefined,
      password: registrationPassword || undefined,
      register: !!body.registrationUser,
      expiry: body.registrationExpiry,
    });
    if (ok) {
      await db.update(carriers).set({ registrationStatus: body.registrationUser ? 'checking' : 'unregistered' }).where(eq(carriers.id, row.id));
    }
  } catch {}

  return c.json(row, 201);
});

router.put('/:id', async (c) => {
  const raw = await c.req.json();
  const body = updateCarrierSchema.parse(raw);
  if (body.name) {
    const [dup] = await db.select({ id: carriers.id }).from(carriers)
      .where(sql`${carriers.name} = ${body.name} AND ${carriers.id} != ${c.req.param('id')}`);
    if (dup) throw new BadRequest('Carrier name already exists');
  }
  const { registrationPassword, ...dbData } = body;
  const [row] = await db.update(carriers).set(dbData).where(eq(carriers.id, c.req.param('id'))).returning();
  if (!row) throw new NotFound('Carrier not found');

  // Re-provision FreeSWITCH gateway
  if (body.registrationUser !== undefined || body.host || body.status) {
    try {
      const { addGateway, removeGateway } = await import('../../esl/commands');
      if (row.status === 'inactive') {
        await removeGateway(row.name);
        await db.update(carriers).set({ registrationStatus: 'unregistered' }).where(eq(carriers.id, row.id));
      } else if (row.registrationUser) {
        const ok = await addGateway(row.name, {
          host: row.host, port: row.port ?? 5060, transport: row.transport ?? 'UDP',
          username: row.registrationUser, password: registrationPassword ?? undefined,
          register: true, expiry: row.registrationExpiry ?? 3600,
        });
        if (ok) {
          await db.update(carriers).set({ registrationStatus: 'checking' }).where(eq(carriers.id, row.id));
        }
      }
    } catch {}
  }

  return c.json(row);
});

router.delete('/:id', async (c) => {
  const [row] = await db.delete(carriers).where(eq(carriers.id, c.req.param('id'))).returning();
  if (!row) throw new NotFound('Carrier not found');

  // Remove FreeSWITCH gateway
  try {
    const { removeGateway } = await import('../../esl/commands');
    await removeGateway(row.name);
  } catch {}

  return c.json({ ok: true });
});

export default router;
