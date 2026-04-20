import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, gte, count } from 'drizzle-orm';
import { db } from '../db/client';
import { contactSubmissions } from '../db/schema';
import { BadRequest } from '../lib/errors';
import { logger } from '../lib/logger';

const router = new Hono();

const contactSchema = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email().max(200),
  company: z.string().max(200).nullable().optional(),
  agents: z.string().max(50).nullable().optional(),
  message: z.string().max(5000).nullable().optional(),
  consent_at: z.string().datetime(),
});

/**
 * Public contact form submission. Rate-limited by IP (max 5/hour) and by email (max 3/hour)
 * to deter automated abuse. Stores the submission for audit and logs for operator follow-up.
 * No auth required.
 */
router.post('/contact', async (c) => {
  const body = contactSchema.parse(await c.req.json());
  const ip = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for')?.split(',')[0] || 'unknown';
  const userAgent = c.req.header('user-agent') ?? null;

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

  const [ipCount] = await db.select({ n: count() }).from(contactSubmissions)
    .where(and(eq(contactSubmissions.ip, ip), gte(contactSubmissions.createdAt, oneHourAgo)));
  if (Number(ipCount.n) >= 5) {
    throw new BadRequest('Too many submissions from this network. Please try again in an hour or email hello@treepbx.com.');
  }

  const [emailCount] = await db.select({ n: count() }).from(contactSubmissions)
    .where(and(eq(contactSubmissions.email, body.email), gte(contactSubmissions.createdAt, oneHourAgo)));
  if (Number(emailCount.n) >= 3) {
    throw new BadRequest('We\u2019ve already received a few messages from this email recently. We\u2019ll respond soon.');
  }

  const [row] = await db.insert(contactSubmissions).values({
    name: body.name,
    email: body.email,
    company: body.company || null,
    agents: body.agents || null,
    message: body.message || null,
    ip,
    userAgent,
    consentAt: new Date(body.consent_at),
  }).returning({ id: contactSubmissions.id });

  logger.info({
    submissionId: row.id, email: body.email, company: body.company, ip,
  }, '[contact] new submission');

  // TODO(ops): hook up transactional email notification to hello@treepbx.com.
  // For now the insert + log is the durable signal; ops can query the table
  // or tail logs. See /root/treepbx-backend/src/lib/email.ts once it exists.

  return c.json({ ok: true }, 201);
});

export default router;
