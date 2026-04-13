import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, desc, count, isNull, inArray } from 'drizzle-orm';
import { db } from '../../db/client';
import { chatChannels, chatChannelMembers, chatMessages, users } from '../../db/schema';
import { paginationSchema, paginate, paginatedResponse } from '../../lib/pagination';
import { NotFound } from '../../lib/errors';

const router = new Hono();

// List chat channels with member info
router.get('/channels', async (c) => {
  const tenantId = c.get('tenantId')!;
  const userId = c.get('user').sub;

  const channels = await db.select().from(chatChannels)
    .where(eq(chatChannels.tenantId, tenantId))
    .orderBy(desc(chatChannels.createdAt));

  // Enrich with member list
  const channelIds = channels.map((ch) => ch.id);
  const members = channelIds.length
    ? await db.select({
        channelId: chatChannelMembers.channelId,
        userId: chatChannelMembers.userId,
        joinedAt: chatChannelMembers.joinedAt,
        firstName: users.firstName,
        lastName: users.lastName,
      }).from(chatChannelMembers)
        .innerJoin(users, eq(chatChannelMembers.userId, users.id))
        .where(inArray(chatChannelMembers.channelId, channelIds))
    : [];

  const memberMap: Record<string, typeof members> = {};
  for (const m of members) {
    if (!memberMap[m.channelId]) memberMap[m.channelId] = [];
    memberMap[m.channelId].push(m);
  }

  return c.json(channels.map((ch) => ({ ...ch, members: memberMap[ch.id] ?? [] })));
});

// Get messages for channel
router.get('/channels/:id/messages', async (c) => {
  const tenantId = c.get('tenantId')!;
  const channelId = c.req.param('id');

  const [channel] = await db.select({ id: chatChannels.id }).from(chatChannels)
    .where(and(eq(chatChannels.id, channelId), eq(chatChannels.tenantId, tenantId)));
  if (!channel) throw new NotFound('Channel not found');

  const raw = paginationSchema.parse(c.req.query());
  const { offset, limit } = paginate(raw);
  const where = and(eq(chatMessages.channelId, channelId), eq(chatMessages.tenantId, tenantId));

  const [rows, [{ total }]] = await Promise.all([
    db.select({
      id: chatMessages.id,
      channelId: chatMessages.channelId,
      senderId: chatMessages.senderId,
      content: chatMessages.content,
      attachmentUrl: chatMessages.attachmentUrl,
      createdAt: chatMessages.createdAt,
    }).from(chatMessages).where(where).orderBy(desc(chatMessages.createdAt)).limit(limit).offset(offset),
    db.select({ total: count() }).from(chatMessages).where(where),
  ]);

  return c.json(paginatedResponse(rows, Number(total), raw));
});

// Send message to channel
router.post('/channels/:id/messages', async (c) => {
  const tenantId = c.get('tenantId')!;
  const userId = c.get('user').sub;
  const channelId = c.req.param('id');

  const [channel] = await db.select({ id: chatChannels.id }).from(chatChannels)
    .where(and(eq(chatChannels.id, channelId), eq(chatChannels.tenantId, tenantId)));
  if (!channel) throw new NotFound('Channel not found');

  const body = z.object({
    content: z.string().min(1),
    attachmentUrl: z.string().url().optional(),
  }).parse(await c.req.json());

  const [row] = await db.insert(chatMessages).values({
    tenantId,
    channelId,
    senderId: userId,
    content: body.content,
    attachmentUrl: body.attachmentUrl,
  }).returning();

  return c.json(row, 201);
});

// List tenant users for DM
router.get('/dm-users', async (c) => {
  const tenantId = c.get('tenantId')!;
  const userId = c.get('user').sub;

  const tenantUsers = await db.select({
    id: users.id,
    firstName: users.firstName,
    lastName: users.lastName,
    email: users.email,
    role: users.role,
    status: users.status,
  }).from(users)
    .where(and(eq(users.tenantId, tenantId), isNull(users.deletedAt)))
    .orderBy(users.firstName);

  // Exclude current user
  return c.json(tenantUsers.filter((u) => u.id !== userId));
});

export default router;
