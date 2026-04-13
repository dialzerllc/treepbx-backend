import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, desc, count } from 'drizzle-orm';
import { db } from '../../db/client';
import {
  voicebotConfigs, kbSources, voicebotIntents, voicebotFlows, voicebotConversations,
} from '../../db/schema';
import { paginationSchema, paginate, paginatedResponse } from '../../lib/pagination';
import { NotFound } from '../../lib/errors';
import { requireRole } from '../../middleware/roles';

const router = new Hono();

const configSchema = z.object({
  name: z.string().min(1),
  ollamaModel: z.string().default('llama3'),
  engineStt: z.string().default('whisper'),
  engineTts: z.string().default('piper'),
  ttsVoice: z.string().default('en-US-male'),
  systemPrompt: z.string().optional(),
  maxTurns: z.number().int().positive().default(10),
  tone: z.string().default('professional'),
  language: z.string().default('en'),
  temperature: z.union([z.number(), z.string()]).transform(String).default('0.7'),
  guardrails: z.record(z.unknown()).optional(),
});

const kbSourceSchema = z.object({
  name: z.string().min(1),
  sourceType: z.enum(['file', 'url', 'faq']),
  sourceUrl: z.string().url().optional(),
  minioKey: z.string().optional(),
  question: z.string().optional(),
  answer: z.string().optional(),
});

const intentSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  trainingPhrases: z.array(z.string()).default([]),
  action: z.string().min(1),
  responseTemplate: z.string().optional(),
  sortOrder: z.number().int().min(0).default(0),
});

const flowSchema = z.object({
  name: z.string().min(1),
  botMessage: z.string().min(1),
  expectedResponses: z.array(z.string()).default([]),
  nextFlowId: z.string().uuid().nullable().optional(),
  stepOrder: z.number().int().min(0).default(0),
});

// List voicebot configs
router.get('/', async (c) => {
  const tenantId = c.get('tenantId')!;
  const raw = paginationSchema.parse(c.req.query());
  const { offset, limit } = paginate(raw);
  const where = eq(voicebotConfigs.tenantId, tenantId);

  const [rows, [{ total }]] = await Promise.all([
    db.select().from(voicebotConfigs).where(where).orderBy(desc(voicebotConfigs.createdAt)).limit(limit).offset(offset),
    db.select({ total: count() }).from(voicebotConfigs).where(where),
  ]);

  return c.json(paginatedResponse(rows, Number(total), raw));
});

router.get('/:id', async (c) => {
  const tenantId = c.get('tenantId')!;
  const [row] = await db.select().from(voicebotConfigs)
    .where(and(eq(voicebotConfigs.id, c.req.param('id')), eq(voicebotConfigs.tenantId, tenantId)));
  if (!row) throw new NotFound('Voicebot config not found');
  return c.json(row);
});

router.post('/', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = configSchema.parse(await c.req.json());
  const [row] = await db.insert(voicebotConfigs).values({ ...body, tenantId }).returning();
  return c.json(row, 201);
});

router.put('/:id', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = configSchema.partial().parse(await c.req.json());
  const [row] = await db.update(voicebotConfigs).set(body)
    .where(and(eq(voicebotConfigs.id, c.req.param('id')), eq(voicebotConfigs.tenantId, tenantId)))
    .returning();
  if (!row) throw new NotFound('Voicebot config not found');
  return c.json(row);
});

router.delete('/:id', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const [row] = await db.delete(voicebotConfigs)
    .where(and(eq(voicebotConfigs.id, c.req.param('id')), eq(voicebotConfigs.tenantId, tenantId)))
    .returning();
  if (!row) throw new NotFound('Voicebot config not found');
  return c.json({ ok: true });
});

// Helper to verify bot ownership
async function getBotOrThrow(id: string, tenantId: string) {
  const [row] = await db.select({ id: voicebotConfigs.id }).from(voicebotConfigs)
    .where(and(eq(voicebotConfigs.id, id), eq(voicebotConfigs.tenantId, tenantId)));
  if (!row) throw new NotFound('Voicebot config not found');
  return row;
}

// KB Sources
router.get('/:id/kb', async (c) => {
  const tenantId = c.get('tenantId')!;
  await getBotOrThrow(c.req.param('id'), tenantId);
  const rows = await db.select().from(kbSources)
    .where(and(eq(kbSources.voicebotConfigId, c.req.param('id')), eq(kbSources.tenantId, tenantId)));
  return c.json(rows);
});

router.post('/:id/kb', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  await getBotOrThrow(c.req.param('id'), tenantId);
  const body = kbSourceSchema.parse(await c.req.json());
  const [row] = await db.insert(kbSources).values({ ...body, voicebotConfigId: c.req.param('id'), tenantId }).returning();
  return c.json(row, 201);
});

router.delete('/:id/kb/:kid', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  await getBotOrThrow(c.req.param('id'), tenantId);
  const [row] = await db.delete(kbSources)
    .where(and(eq(kbSources.id, c.req.param('kid')), eq(kbSources.tenantId, tenantId)))
    .returning();
  if (!row) throw new NotFound('KB source not found');
  return c.json({ ok: true });
});

// Intents
router.get('/:id/intents', async (c) => {
  const tenantId = c.get('tenantId')!;
  await getBotOrThrow(c.req.param('id'), tenantId);
  const rows = await db.select().from(voicebotIntents)
    .where(and(eq(voicebotIntents.voicebotConfigId, c.req.param('id')), eq(voicebotIntents.tenantId, tenantId)));
  return c.json(rows);
});

router.post('/:id/intents', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  await getBotOrThrow(c.req.param('id'), tenantId);
  const body = intentSchema.parse(await c.req.json());
  const [row] = await db.insert(voicebotIntents).values({ ...body, voicebotConfigId: c.req.param('id'), tenantId }).returning();
  return c.json(row, 201);
});

router.put('/:id/intents/:iid', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  await getBotOrThrow(c.req.param('id'), tenantId);
  const body = intentSchema.partial().parse(await c.req.json());
  const [row] = await db.update(voicebotIntents).set(body)
    .where(and(eq(voicebotIntents.id, c.req.param('iid')), eq(voicebotIntents.tenantId, tenantId)))
    .returning();
  if (!row) throw new NotFound('Intent not found');
  return c.json(row);
});

router.delete('/:id/intents/:iid', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  await getBotOrThrow(c.req.param('id'), tenantId);
  const [row] = await db.delete(voicebotIntents)
    .where(and(eq(voicebotIntents.id, c.req.param('iid')), eq(voicebotIntents.tenantId, tenantId)))
    .returning();
  if (!row) throw new NotFound('Intent not found');
  return c.json({ ok: true });
});

// Flows
router.get('/:id/flows', async (c) => {
  const tenantId = c.get('tenantId')!;
  await getBotOrThrow(c.req.param('id'), tenantId);
  const rows = await db.select().from(voicebotFlows)
    .where(and(eq(voicebotFlows.voicebotConfigId, c.req.param('id')), eq(voicebotFlows.tenantId, tenantId)));
  return c.json(rows);
});

router.post('/:id/flows', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  await getBotOrThrow(c.req.param('id'), tenantId);
  const body = flowSchema.parse(await c.req.json());
  const [row] = await db.insert(voicebotFlows).values({ ...body, voicebotConfigId: c.req.param('id'), tenantId }).returning();
  return c.json(row, 201);
});

router.put('/:id/flows/:fid', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  await getBotOrThrow(c.req.param('id'), tenantId);
  const body = flowSchema.partial().parse(await c.req.json());
  const [row] = await db.update(voicebotFlows).set(body)
    .where(and(eq(voicebotFlows.id, c.req.param('fid')), eq(voicebotFlows.tenantId, tenantId)))
    .returning();
  if (!row) throw new NotFound('Flow not found');
  return c.json(row);
});

router.delete('/:id/flows/:fid', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  await getBotOrThrow(c.req.param('id'), tenantId);
  const [row] = await db.delete(voicebotFlows)
    .where(and(eq(voicebotFlows.id, c.req.param('fid')), eq(voicebotFlows.tenantId, tenantId)))
    .returning();
  if (!row) throw new NotFound('Flow not found');
  return c.json({ ok: true });
});

// System prompt
router.get('/:id/prompt', async (c) => {
  const tenantId = c.get('tenantId')!;
  const [row] = await db.select({ systemPrompt: voicebotConfigs.systemPrompt }).from(voicebotConfigs)
    .where(and(eq(voicebotConfigs.id, c.req.param('id')), eq(voicebotConfigs.tenantId, tenantId)));
  if (!row) throw new NotFound('Voicebot config not found');
  return c.json({ systemPrompt: row.systemPrompt });
});

router.put('/:id/prompt', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = z.object({ systemPrompt: z.string() }).parse(await c.req.json());
  const [row] = await db.update(voicebotConfigs).set({ systemPrompt: body.systemPrompt })
    .where(and(eq(voicebotConfigs.id, c.req.param('id')), eq(voicebotConfigs.tenantId, tenantId)))
    .returning();
  if (!row) throw new NotFound('Voicebot config not found');
  return c.json({ systemPrompt: row.systemPrompt });
});

// Test chat - placeholder
router.post('/:id/test/chat', async (c) => {
  const body = z.object({ message: z.string() }).parse(await c.req.json());
  return c.json({
    response: `[Mock bot response to: "${body.message}"]`,
    turn: 1,
    intent: 'unknown',
  });
});

// Analytics - placeholder
router.get('/:id/analytics', async (c) => {
  const tenantId = c.get('tenantId')!;
  await getBotOrThrow(c.req.param('id'), tenantId);
  return c.json({ totalConversations: 0, avgTurns: 0, outcomeBreakdown: {} });
});

// Conversation logs
router.get('/:id/logs', async (c) => {
  const tenantId = c.get('tenantId')!;
  await getBotOrThrow(c.req.param('id'), tenantId);
  const raw = paginationSchema.parse(c.req.query());
  const { offset, limit } = paginate(raw);
  const where = and(eq(voicebotConversations.voicebotConfigId, c.req.param('id')), eq(voicebotConversations.tenantId, tenantId));

  const [rows, [{ total }]] = await Promise.all([
    db.select().from(voicebotConversations).where(where).orderBy(desc(voicebotConversations.createdAt)).limit(limit).offset(offset),
    db.select({ total: count() }).from(voicebotConversations).where(where),
  ]);

  return c.json(paginatedResponse(rows, Number(total), raw));
});

export default router;
