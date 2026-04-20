import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, like, desc, count } from 'drizzle-orm';
import { db } from '../../db/client';
import { supportTickets, ticketMessages } from '../../db/schema';
import { paginationSchema, paginate, paginatedResponse } from '../../lib/pagination';
import { NotFound } from '../../lib/errors';

const router = new Hono();

const ticketSchema = z.object({
  subject: z.string().min(1),
  description: z.string().nullable().optional(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).default('medium'),
  category: z.string().nullable().optional(),
});

function generateTicketNumber() {
  return `TKT-${Date.now().toString(36).toUpperCase()}`;
}

// List tickets
router.get('/', async (c) => {
  const tenantId = c.get('tenantId')!;
  const raw = paginationSchema.extend({
    status: z.string().nullable().optional(),
    priority: z.string().nullable().optional(),
  }).passthrough().parse(c.req.query());
  const { offset, limit } = paginate(raw);

  const conditions: any[] = [eq(supportTickets.tenantId, tenantId)];
  if (raw.search) conditions.push(like(supportTickets.subject, `%${raw.search}%`));
  if (raw.status) conditions.push(eq(supportTickets.status, raw.status));
  if (raw.priority) conditions.push(eq(supportTickets.priority, raw.priority));
  const where = and(...conditions);

  const [rows, [{ total }]] = await Promise.all([
    db.select().from(supportTickets).where(where).orderBy(desc(supportTickets.createdAt)).limit(limit).offset(offset),
    db.select({ total: count() }).from(supportTickets).where(where),
  ]);

  return c.json(paginatedResponse(rows, Number(total), raw));
});

// Get ticket
router.get('/:id', async (c) => {
  const tenantId = c.get('tenantId')!;
  const [row] = await db.select().from(supportTickets)
    .where(and(eq(supportTickets.id, c.req.param('id')), eq(supportTickets.tenantId, tenantId)));
  if (!row) throw new NotFound('Ticket not found');
  return c.json(row);
});

// Create ticket
router.post('/', async (c) => {
  const tenantId = c.get('tenantId')!;
  const userId = c.get('user').sub;
  const body = ticketSchema.parse(await c.req.json());
  const [row] = await db.insert(supportTickets).values({
    ...body,
    tenantId,
    createdBy: userId,
    ticketNumber: generateTicketNumber(),
  }).returning();
  return c.json(row, 201);
});

// Update ticket
router.put('/:id', async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = z.object({
    status: z.enum(['open', 'in_progress', 'resolved', 'closed']).optional(),
    priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
    assignedTo: z.string().nullable().optional().transform((v) => v && /^[0-9a-f-]{36}$/i.test(v) ? v : null),
  }).passthrough().parse(await c.req.json());

  const [row] = await db.update(supportTickets)
    .set({ ...body, updatedAt: new Date() })
    .where(and(eq(supportTickets.id, c.req.param('id')), eq(supportTickets.tenantId, tenantId)))
    .returning();
  if (!row) throw new NotFound('Ticket not found');
  return c.json(row);
});

// Delete ticket
router.delete('/:id', async (c) => {
  const tenantId = c.get('tenantId')!;
  const [row] = await db.delete(supportTickets)
    .where(and(eq(supportTickets.id, c.req.param('id')), eq(supportTickets.tenantId, tenantId)))
    .returning();
  if (!row) throw new NotFound('Ticket not found');
  return c.json({ ok: true });
});

// List ticket messages
router.get('/:id/messages', async (c) => {
  const tenantId = c.get('tenantId')!;
  const [ticket] = await db.select({ id: supportTickets.id }).from(supportTickets)
    .where(and(eq(supportTickets.id, c.req.param('id')), eq(supportTickets.tenantId, tenantId)));
  if (!ticket) throw new NotFound('Ticket not found');

  const rows = await db.select().from(ticketMessages)
    .where(eq(ticketMessages.ticketId, ticket.id))
    .orderBy(ticketMessages.createdAt);

  return c.json({ data: rows });
});

// Add ticket message
router.post('/:id/messages', async (c) => {
  const tenantId = c.get('tenantId')!;
  const userId = c.get('user').sub;
  const [ticket] = await db.select({ id: supportTickets.id }).from(supportTickets)
    .where(and(eq(supportTickets.id, c.req.param('id')), eq(supportTickets.tenantId, tenantId)));
  if (!ticket) throw new NotFound('Ticket not found');

  const raw = await c.req.json();
  // Frontend sends 'message', backend uses 'content'
  if (raw.message && !raw.content) raw.content = raw.message;
  // Frontend sends 'attachmentName', backend uses 'attachmentUrl'
  if (raw.attachmentName && !raw.attachmentUrl) raw.attachmentUrl = raw.attachmentName;
  const body = z.object({
    content: z.string().min(1),
    isInternal: z.boolean().nullable().default(false),
    attachmentUrl: z.string().optional(),
  }).passthrough().parse(raw);

  const [row] = await db.insert(ticketMessages).values({
    ticketId: ticket.id,
    senderId: userId,
    content: body.content,
    isInternal: body.isInternal,
    attachmentUrl: body.attachmentUrl,
  }).returning();

  return c.json(row, 201);
});

export default router;
