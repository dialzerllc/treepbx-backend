import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, desc, asc, count, isNull, inArray, gt, ne, sql, or } from 'drizzle-orm';
import { db } from '../../db/client';
import { chatChannels, chatChannelMembers, chatMessages, users, dmConversations, dmMessages, chatReadMarkers, chatReactions } from '../../db/schema';
import { paginationSchema, paginate, paginatedResponse } from '../../lib/pagination';
import { NotFound, BadRequest } from '../../lib/errors';
import { uploadFile, getFileUrl } from '../../integrations/minio';
import { broadcastToRoom } from '../../ws/rooms';

const router = new Hono();

// ─── Channel endpoints ────────────────────────────────────────────────────────

// List chat channels with unread counts per user
router.get('/channels', async (c) => {
  const tenantId = c.get('tenantId')!;
  const userId = c.get('user').sub;

  // Auto-create General channel if tenant has none
  const [existingCount] = await db.select({ cnt: count() }).from(chatChannels).where(eq(chatChannels.tenantId, tenantId));
  if (Number(existingCount.cnt) === 0) {
    const [general] = await db.insert(chatChannels).values({ tenantId, name: 'General', type: 'group' }).returning();
    // Add all tenant users as members
    const tenantUsers = await db.select({ id: users.id }).from(users).where(and(eq(users.tenantId, tenantId), isNull(users.deletedAt)));
    if (tenantUsers.length > 0) {
      await db.insert(chatChannelMembers).values(tenantUsers.map((u) => ({ channelId: general.id, userId: u.id }))).onConflictDoNothing();
    }
  }

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

  // Unread per channel: messages newer than this user's read marker
  // (or all messages if no marker), excluding deleted and own messages.
  const unreadCounts = channelIds.length
    ? await db.select({
        channelId: chatMessages.channelId,
        cnt: count(),
      }).from(chatMessages)
        .leftJoin(chatReadMarkers, and(
          eq(chatReadMarkers.channelId, chatMessages.channelId),
          eq(chatReadMarkers.userId, userId),
        ))
        .where(and(
          inArray(chatMessages.channelId, channelIds),
          isNull(chatMessages.deletedAt),
          ne(chatMessages.senderId, userId),
          or(
            isNull(chatReadMarkers.lastReadAt),
            gt(chatMessages.createdAt, chatReadMarkers.lastReadAt),
          ),
        ))
        .groupBy(chatMessages.channelId)
    : [];

  const unreadMap: Record<string, number> = {};
  for (const u of unreadCounts) {
    if (u.channelId) unreadMap[u.channelId] = Number(u.cnt);
  }

  const enriched = channels.map((ch) => ({
    ...ch,
    members: memberMap[ch.id] ?? [],
    unreadCount: unreadMap[ch.id] ?? 0,
  }));

  return c.json({ data: enriched });
});

// Get channel members
router.get('/channels/:id/members', async (c) => {
  const channelId = c.req.param('id');
  const members = await db.select({
    userId: chatChannelMembers.userId,
    firstName: users.firstName,
    lastName: users.lastName,
    email: users.email,
    status: users.status,
  }).from(chatChannelMembers)
    .innerJoin(users, eq(chatChannelMembers.userId, users.id))
    .where(eq(chatChannelMembers.channelId, channelId));
  return c.json({ data: members });
});

// Add members to channel
router.post('/channels/:id/members', async (c) => {
  const channelId = c.req.param('id');
  const body = z.object({ userIds: z.array(z.string().uuid()) }).parse(await c.req.json());
  if (body.userIds.length > 0) {
    await db.insert(chatChannelMembers)
      .values(body.userIds.map((userId) => ({ channelId, userId })))
      .onConflictDoNothing();
  }
  return c.json({ ok: true, added: body.userIds.length });
});

// Remove member from channel
router.delete('/channels/:id/members/:userId', async (c) => {
  const channelId = c.req.param('id');
  const userId = c.req.param('userId');
  await db.delete(chatChannelMembers)
    .where(and(eq(chatChannelMembers.channelId, channelId), eq(chatChannelMembers.userId, userId)));
  return c.json({ ok: true });
});

// Delete channel
router.delete('/channels/:id', async (c) => {
  const tenantId = c.get('tenantId')!;
  const channelId = c.req.param('id');

  // Delete messages, members, read markers, then channel
  await db.delete(chatMessages).where(eq(chatMessages.channelId, channelId));
  await db.delete(chatChannelMembers).where(eq(chatChannelMembers.channelId, channelId));
  await db.delete(chatReadMarkers).where(eq(chatReadMarkers.channelId, channelId));
  const [row] = await db.delete(chatChannels)
    .where(and(eq(chatChannels.id, channelId), eq(chatChannels.tenantId, tenantId)))
    .returning();
  if (!row) throw new NotFound('Channel not found');
  return c.json({ ok: true });
});

// Create channel
router.post('/channels', async (c) => {
  const tenantId = c.get('tenantId')!;
  const userId = c.get('user').sub;

  const body = z.object({
    name: z.string().min(1).max(100),
    type: z.enum(['group', 'public']).default('group'),
    memberIds: z.array(z.string().uuid()).optional(),
  }).parse(await c.req.json());

  const [channel] = await db.insert(chatChannels).values({
    tenantId,
    name: body.name,
    type: body.type,
  }).returning();

  // Add creator as member
  const memberIds = new Set(body.memberIds ?? []);
  memberIds.add(userId);

  await db.insert(chatChannelMembers).values(
    Array.from(memberIds).map((uid) => ({ channelId: channel.id, userId: uid }))
  );

  return c.json(channel, 201);
});

// Get messages for channel (paginated, supports parentId filter, excludes deleted)
router.get('/channels/:id/messages', async (c) => {
  const tenantId = c.get('tenantId')!;
  const channelId = c.req.param('id');
  const parentId = c.req.query('parentId');

  const [channel] = await db.select({ id: chatChannels.id }).from(chatChannels)
    .where(and(eq(chatChannels.id, channelId), eq(chatChannels.tenantId, tenantId)));
  if (!channel) throw new NotFound('Channel not found');

  const raw = paginationSchema.parse(c.req.query());
  const { offset, limit } = paginate(raw);

  const conditions = [
    eq(chatMessages.channelId, channelId),
    eq(chatMessages.tenantId, tenantId),
    isNull(chatMessages.deletedAt),
  ];

  if (parentId) {
    conditions.push(eq(chatMessages.parentId, parentId));
  } else {
    conditions.push(isNull(chatMessages.parentId));
  }

  const where = and(...conditions);

  const [rows, [{ total }]] = await Promise.all([
    db.select({
      id: chatMessages.id,
      channelId: chatMessages.channelId,
      senderId: chatMessages.senderId,
      content: chatMessages.content,
      attachmentUrl: chatMessages.attachmentUrl,
      parentId: chatMessages.parentId,
      fileUrl: chatMessages.fileUrl,
      fileName: chatMessages.fileName,
      fileSize: chatMessages.fileSize,
      fileType: chatMessages.fileType,
      editedAt: chatMessages.editedAt,
      createdAt: chatMessages.createdAt,
      senderFirstName: users.firstName,
      senderLastName: users.lastName,
    }).from(chatMessages)
      .leftJoin(users, eq(chatMessages.senderId, users.id))
      .where(where)
      .orderBy(desc(chatMessages.createdAt))
      .limit(limit).offset(offset),
    db.select({ total: count() }).from(chatMessages).where(where),
  ]);

  // Add reply count for top-level messages
  const enriched = parentId ? rows : await Promise.all(rows.map(async (msg) => {
    const [result] = await db.select({ count: count() }).from(chatMessages)
      .where(and(
        eq(chatMessages.parentId, msg.id),
        isNull(chatMessages.deletedAt),
      ));
    return { ...msg, replyCount: Number(result?.count ?? 0) };
  }));

  // Attach reactions
  const reactionsMap = await loadReactions('channel', enriched.map((m) => m.id));
  const withReactions = enriched.map((m) => ({ ...m, reactions: reactionsMap.get(m.id) ?? [] }));

  return c.json(paginatedResponse(withReactions, Number(total), raw));
});

// Send message to channel
router.post('/channels/:id/messages', async (c) => {
  const tenantId = c.get('tenantId')!;
  const userId = c.get('user').sub;
  const channelId = c.req.param('id');

  const [channel] = await db.select({ id: chatChannels.id }).from(chatChannels)
    .where(and(eq(chatChannels.id, channelId), eq(chatChannels.tenantId, tenantId)));
  if (!channel) throw new NotFound('Channel not found');

  const raw = await c.req.json();
  if (raw.message && !raw.content) raw.content = raw.message;

  const body = z.object({
    content: z.string().min(1),
    parentId: z.string().uuid().optional(),
    fileUrl: z.string().optional(),
    fileName: z.string().optional(),
    fileSize: z.number().optional(),
    fileType: z.string().optional(),
    attachmentUrl: z.string().optional().transform((v) => v && v.startsWith('http') ? v : undefined),
  }).passthrough().parse(raw);

  const [row] = await db.insert(chatMessages).values({
    tenantId,
    channelId,
    senderId: userId,
    content: body.content,
    parentId: body.parentId,
    fileUrl: body.fileUrl,
    fileName: body.fileName,
    fileSize: body.fileSize,
    fileType: body.fileType,
    attachmentUrl: body.attachmentUrl,
  }).returning();

  // Get sender info for broadcast
  const [sender] = await db.select({ firstName: users.firstName, lastName: users.lastName })
    .from(users).where(eq(users.id, userId));

  const [channelRow] = await db.select({ name: chatChannels.name }).from(chatChannels)
    .where(eq(chatChannels.id, channelId));

  const msgPayload = {
    ...row,
    senderFirstName: sender?.firstName,
    senderLastName: sender?.lastName,
  };

  // Broadcast to the channel room (all members auto-joined on WS connect).
  broadcastToRoom(`chat:${channelId}`, 'chat:message', {
    channelId,
    channelName: channelRow?.name,
    message: msgPayload,
  });

  return c.json(row, 201);
});

// Get thread replies for a message
router.get('/channels/:id/messages/:msgId/thread', async (c) => {
  const tenantId = c.get('tenantId')!;
  const channelId = c.req.param('id');
  const msgId = c.req.param('msgId');

  const raw = paginationSchema.parse(c.req.query());
  const { offset, limit } = paginate(raw);

  const where = and(
    eq(chatMessages.channelId, channelId),
    eq(chatMessages.tenantId, tenantId),
    eq(chatMessages.parentId, msgId),
    isNull(chatMessages.deletedAt),
  );

  const [rows, [{ total }]] = await Promise.all([
    db.select({
      id: chatMessages.id,
      channelId: chatMessages.channelId,
      senderId: chatMessages.senderId,
      content: chatMessages.content,
      parentId: chatMessages.parentId,
      fileUrl: chatMessages.fileUrl,
      fileName: chatMessages.fileName,
      fileSize: chatMessages.fileSize,
      fileType: chatMessages.fileType,
      editedAt: chatMessages.editedAt,
      createdAt: chatMessages.createdAt,
      senderFirstName: users.firstName,
      senderLastName: users.lastName,
    }).from(chatMessages)
      .leftJoin(users, eq(chatMessages.senderId, users.id))
      .where(where)
      .orderBy(asc(chatMessages.createdAt))
      .limit(limit).offset(offset),
    db.select({ total: count() }).from(chatMessages).where(where),
  ]);

  return c.json(paginatedResponse(rows, Number(total), raw));
});

// Edit message (allowed for 5 minutes after creation)
const EDIT_WINDOW_MS = 5 * 60 * 1000;
router.put('/channels/:id/messages/:msgId', async (c) => {
  const tenantId = c.get('tenantId')!;
  const userId = c.get('user').sub;
  const channelId = c.req.param('id');
  const msgId = c.req.param('msgId');

  const body = z.object({ content: z.string().min(1) }).parse(await c.req.json());

  const [msg] = await db.select().from(chatMessages)
    .where(and(
      eq(chatMessages.id, msgId),
      eq(chatMessages.channelId, channelId),
      eq(chatMessages.senderId, userId),
      isNull(chatMessages.deletedAt),
    ));
  if (!msg) throw new NotFound('Message not found');
  if (msg.createdAt && Date.now() - new Date(msg.createdAt).getTime() > EDIT_WINDOW_MS) {
    throw new BadRequest('Messages can only be edited within 5 minutes of being sent');
  }

  const [updated] = await db.update(chatMessages)
    .set({ content: body.content, editedAt: new Date() })
    .where(eq(chatMessages.id, msgId))
    .returning();

  broadcastToRoom(`chat:${channelId}`, 'chat:message_edited', updated);

  return c.json(updated);
});

// Soft delete message
router.delete('/channels/:id/messages/:msgId', async (c) => {
  const tenantId = c.get('tenantId')!;
  const userId = c.get('user').sub;
  const channelId = c.req.param('id');
  const msgId = c.req.param('msgId');

  const [msg] = await db.select().from(chatMessages)
    .where(and(
      eq(chatMessages.id, msgId),
      eq(chatMessages.channelId, channelId),
      eq(chatMessages.senderId, userId),
      isNull(chatMessages.deletedAt),
    ));
  if (!msg) throw new NotFound('Message not found');

  await db.update(chatMessages)
    .set({ deletedAt: new Date() })
    .where(eq(chatMessages.id, msgId));

  broadcastToRoom(`chat:${channelId}`, 'chat:message_deleted', { id: msgId, channelId });

  return c.json({ success: true });
});

// Mark channel as read
router.post('/channels/:id/read', async (c) => {
  const userId = c.get('user').sub;
  const channelId = c.req.param('id');

  await db.insert(chatReadMarkers).values({
    userId,
    channelId,
    lastReadAt: new Date(),
  }).onConflictDoUpdate({
    target: [chatReadMarkers.userId, chatReadMarkers.channelId],
    set: { lastReadAt: new Date() },
  });

  return c.json({ success: true });
});

// ─── Threads endpoint ────────────────────────────────────────────────────────

// Threads the user participates in across channels AND DMs (started-with-replies
// or replied-in), sorted by most recent reply activity.
router.get('/threads', async (c) => {
  const tenantId = c.get('tenantId')!;
  const userId = c.get('user').sub;

  const raw = paginationSchema.parse(c.req.query());
  const { offset, limit } = paginate(raw);

  // ── Channel thread parents ──
  const [chRepliedIn, chStartedByUser] = await Promise.all([
    db.selectDistinct({ parentId: chatMessages.parentId }).from(chatMessages)
      .where(and(
        eq(chatMessages.tenantId, tenantId),
        eq(chatMessages.senderId, userId),
        isNull(chatMessages.deletedAt),
        sql`${chatMessages.parentId} IS NOT NULL`,
      )),
    db.select({ id: chatMessages.id }).from(chatMessages)
      .where(and(
        eq(chatMessages.tenantId, tenantId),
        eq(chatMessages.senderId, userId),
        isNull(chatMessages.parentId),
        isNull(chatMessages.deletedAt),
      )),
  ]);

  const channelParentIds = new Set<string>();
  for (const r of chRepliedIn) if (r.parentId) channelParentIds.add(r.parentId);
  for (const r of chStartedByUser) channelParentIds.add(r.id);

  const channelRows = channelParentIds.size > 0
    ? await db.select({
        id: chatMessages.id,
        channelId: chatMessages.channelId,
        content: chatMessages.content,
        senderId: chatMessages.senderId,
        createdAt: chatMessages.createdAt,
        fileUrl: chatMessages.fileUrl,
        fileName: chatMessages.fileName,
        senderFirstName: users.firstName,
        senderLastName: users.lastName,
        label: chatChannels.name,
        replyCount: sql<number>`(SELECT COUNT(*) FROM chat_messages r WHERE r.parent_id = ${chatMessages.id} AND r.deleted_at IS NULL)`,
        lastReplyAt: sql<Date | null>`(SELECT MAX(r.created_at) FROM chat_messages r WHERE r.parent_id = ${chatMessages.id} AND r.deleted_at IS NULL)`,
      }).from(chatMessages)
        .leftJoin(users, eq(chatMessages.senderId, users.id))
        .leftJoin(chatChannels, eq(chatMessages.channelId, chatChannels.id))
        .where(and(
          eq(chatMessages.tenantId, tenantId),
          isNull(chatMessages.deletedAt),
          inArray(chatMessages.id, Array.from(channelParentIds)),
        ))
    : [];

  // ── DM thread parents ──
  const [dmRepliedIn, dmStartedByUser] = await Promise.all([
    db.selectDistinct({ parentId: dmMessages.parentId }).from(dmMessages)
      .innerJoin(dmConversations, eq(dmMessages.conversationId, dmConversations.id))
      .where(and(
        eq(dmConversations.tenantId, tenantId),
        eq(dmMessages.senderId, userId),
        sql`${dmMessages.parentId} IS NOT NULL`,
      )),
    db.select({ id: dmMessages.id }).from(dmMessages)
      .innerJoin(dmConversations, eq(dmMessages.conversationId, dmConversations.id))
      .where(and(
        eq(dmConversations.tenantId, tenantId),
        eq(dmMessages.senderId, userId),
        isNull(dmMessages.parentId),
      )),
  ]);

  const dmParentIds = new Set<string>();
  for (const r of dmRepliedIn) if (r.parentId) dmParentIds.add(r.parentId);
  for (const r of dmStartedByUser) dmParentIds.add(r.id);

  const dmRows = dmParentIds.size > 0
    ? await db.select({
        id: dmMessages.id,
        conversationId: dmMessages.conversationId,
        content: dmMessages.content,
        senderId: dmMessages.senderId,
        createdAt: dmMessages.createdAt,
        fileUrl: dmMessages.fileUrl,
        fileName: dmMessages.fileName,
        senderFirstName: users.firstName,
        senderLastName: users.lastName,
        userA: dmConversations.userA,
        userB: dmConversations.userB,
        replyCount: sql<number>`(SELECT COUNT(*) FROM dm_messages r WHERE r.parent_id = ${dmMessages.id})`,
        lastReplyAt: sql<Date | null>`(SELECT MAX(r.created_at) FROM dm_messages r WHERE r.parent_id = ${dmMessages.id})`,
      }).from(dmMessages)
        .innerJoin(dmConversations, eq(dmMessages.conversationId, dmConversations.id))
        .leftJoin(users, eq(dmMessages.senderId, users.id))
        .where(and(
          eq(dmConversations.tenantId, tenantId),
          inArray(dmMessages.id, Array.from(dmParentIds)),
        ))
    : [];

  // Resolve the other user's name per DM for the label
  const otherUserIds = [...new Set(dmRows.map((t) => (t.userA === userId ? t.userB : t.userA)))];
  const otherUsers = otherUserIds.length > 0
    ? await db.select({ id: users.id, firstName: users.firstName, lastName: users.lastName })
        .from(users).where(inArray(users.id, otherUserIds))
    : [];
  const otherNameMap: Record<string, string> = {};
  for (const u of otherUsers) otherNameMap[u.id] = `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim();

  const allThreads = [
    ...channelRows.map((t) => ({
      kind: 'channel' as const,
      id: t.id,
      channelId: t.channelId,
      conversationId: null as string | null,
      label: t.label ?? '',
      content: t.content,
      senderId: t.senderId,
      senderFirstName: t.senderFirstName,
      senderLastName: t.senderLastName,
      createdAt: t.createdAt,
      replyCount: Number(t.replyCount ?? 0),
      lastReplyAt: t.lastReplyAt,
    })),
    ...dmRows.map((t) => {
      const otherId = t.userA === userId ? t.userB : t.userA;
      return {
        kind: 'dm' as const,
        id: t.id,
        channelId: null as string | null,
        conversationId: t.conversationId,
        label: otherNameMap[otherId] ?? 'Direct message',
        content: t.content,
        senderId: t.senderId,
        senderFirstName: t.senderFirstName,
        senderLastName: t.senderLastName,
        createdAt: t.createdAt,
        replyCount: Number(t.replyCount ?? 0),
        lastReplyAt: t.lastReplyAt,
      };
    }),
  ];

  const active = allThreads
    .filter((t) => t.replyCount > 0)
    .sort((a, b) => {
      const at = a.lastReplyAt ? new Date(a.lastReplyAt as any).getTime() : 0;
      const bt = b.lastReplyAt ? new Date(b.lastReplyAt as any).getTime() : 0;
      return bt - at;
    });

  const page = active.slice(offset, offset + limit);
  return c.json(paginatedResponse(page, active.length, raw));
});

// ─── DM endpoints ─────────────────────────────────────────────────────────────

// List user's DM conversations
router.get('/dm', async (c) => {
  const tenantId = c.get('tenantId')!;
  const userId = c.get('user').sub;

  const conversations = await db.select().from(dmConversations)
    .where(and(
      eq(dmConversations.tenantId, tenantId),
      or(eq(dmConversations.userA, userId), eq(dmConversations.userB, userId)),
    ))
    .orderBy(desc(dmConversations.lastMessageAt));

  // Get read markers for DM conversations
  const convIds = conversations.map((c) => c.id);
  const markers = convIds.length
    ? await db.select({
        conversationId: chatReadMarkers.conversationId,
        lastReadAt: chatReadMarkers.lastReadAt,
      }).from(chatReadMarkers)
        .where(and(eq(chatReadMarkers.userId, userId), inArray(chatReadMarkers.conversationId, convIds)))
    : [];

  const markerMap: Record<string, Date | null> = {};
  for (const m of markers) {
    if (m.conversationId) markerMap[m.conversationId] = m.lastReadAt;
  }

  // Batch: get all other user IDs and fetch in one query
  const otherUserIds = [...new Set(conversations.map((c) => c.userA === userId ? c.userB : c.userA))];
  const otherUsers = otherUserIds.length
    ? await db.select({ id: users.id, firstName: users.firstName, lastName: users.lastName, email: users.email, status: users.status })
        .from(users).where(inArray(users.id, otherUserIds))
    : [];
  const userMap: Record<string, typeof otherUsers[0]> = {};
  for (const u of otherUsers) userMap[u.id] = u;

  const enriched = conversations.map((conv) => {
    const otherUserId = conv.userA === userId ? conv.userB : conv.userA;
    return {
      ...conv,
      otherUser: userMap[otherUserId] ?? { id: otherUserId, firstName: 'Unknown', lastName: '', email: '', status: 'offline' },
      lastMessage: null,
      unreadCount: 0,
    };
  });

  return c.json({ data: enriched });
});

// Start or get DM conversation
router.post('/dm', async (c) => {
  const tenantId = c.get('tenantId')!;
  const userId = c.get('user').sub;

  const body = z.object({ userId: z.string().uuid() }).parse(await c.req.json());
  if (body.userId === userId) throw new BadRequest('Cannot DM yourself');

  // Normalize order: lower UUID = userA
  const [userA, userB] = userId < body.userId ? [userId, body.userId] : [body.userId, userId];

  // Find existing or create
  const [existing] = await db.select().from(dmConversations)
    .where(and(
      eq(dmConversations.tenantId, tenantId),
      eq(dmConversations.userA, userA),
      eq(dmConversations.userB, userB),
    ));

  if (existing) return c.json(existing);

  const [conv] = await db.insert(dmConversations).values({
    tenantId,
    userA,
    userB,
  }).returning();

  return c.json(conv, 201);
});

// Get DM messages (paginated)
router.get('/dm/:id/messages', async (c) => {
  const userId = c.get('user').sub;
  const conversationId = c.req.param('id');

  // Verify user is part of conversation
  const [conv] = await db.select().from(dmConversations)
    .where(and(
      eq(dmConversations.id, conversationId),
      or(eq(dmConversations.userA, userId), eq(dmConversations.userB, userId)),
    ));
  if (!conv) throw new NotFound('Conversation not found');

  const raw = paginationSchema.parse(c.req.query());
  const { offset, limit } = paginate(raw);

  const where = eq(dmMessages.conversationId, conversationId);

  const [rows, [{ total }]] = await Promise.all([
    db.select({
      id: dmMessages.id,
      conversationId: dmMessages.conversationId,
      senderId: dmMessages.senderId,
      content: dmMessages.content,
      parentId: dmMessages.parentId,
      fileUrl: dmMessages.fileUrl,
      fileName: dmMessages.fileName,
      fileSize: dmMessages.fileSize,
      fileType: dmMessages.fileType,
      createdAt: dmMessages.createdAt,
      senderFirstName: users.firstName,
      senderLastName: users.lastName,
      replyCount: sql<number>`(SELECT COUNT(*) FROM dm_messages r WHERE r.parent_id = ${dmMessages.id})`,
    }).from(dmMessages)
      .leftJoin(users, eq(dmMessages.senderId, users.id))
      .where(where)
      .orderBy(desc(dmMessages.createdAt))
      .limit(limit).offset(offset),
    db.select({ total: count() }).from(dmMessages).where(where),
  ]);

  const enriched = rows.map((r) => ({ ...r, replyCount: Number(r.replyCount ?? 0) }));
  const reactionsMap = await loadReactions('dm', enriched.map((m) => m.id));
  const withReactions = enriched.map((m) => ({ ...m, reactions: reactionsMap.get(m.id) ?? [] }));
  return c.json(paginatedResponse(withReactions, Number(total), raw));
});

// Send DM message
router.post('/dm/:id/messages', async (c) => {
  const userId = c.get('user').sub;
  const conversationId = c.req.param('id');

  // Verify user is part of conversation
  const [conv] = await db.select().from(dmConversations)
    .where(and(
      eq(dmConversations.id, conversationId),
      or(eq(dmConversations.userA, userId), eq(dmConversations.userB, userId)),
    ));
  if (!conv) throw new NotFound('Conversation not found');

  const raw = await c.req.json();
  if (raw.message && !raw.content) raw.content = raw.message;

  const body = z.object({
    content: z.string().min(1),
    parentId: z.string().uuid().optional(),
    fileUrl: z.string().optional(),
    fileName: z.string().optional(),
    fileSize: z.number().optional(),
    fileType: z.string().optional(),
  }).passthrough().parse(raw);

  const [row] = await db.insert(dmMessages).values({
    conversationId,
    senderId: userId,
    content: body.content,
    parentId: body.parentId,
    fileUrl: body.fileUrl,
    fileName: body.fileName,
    fileSize: body.fileSize,
    fileType: body.fileType,
  }).returning();

  // Update last message timestamp
  await db.update(dmConversations)
    .set({ lastMessageAt: new Date() })
    .where(eq(dmConversations.id, conversationId));

  // Get sender info
  const [sender] = await db.select({ firstName: users.firstName, lastName: users.lastName })
    .from(users).where(eq(users.id, userId));

  const msgPayload = {
    ...row,
    senderFirstName: sender?.firstName,
    senderLastName: sender?.lastName,
  };

  // Broadcast to DM room + both user agent rooms for notification
  const dmPayload = { conversationId, message: msgPayload };
  broadcastToRoom(`dm:${conversationId}`, 'chat:dm', dmPayload);

  // Also notify via agent rooms so users get it even without Team Chat open
  if (conv) {
    const { sendToAgent } = await import('../../ws/rooms');
    sendToAgent(conv.userA, 'chat:dm_notify', {
      conversationId,
      senderName: `${sender?.firstName ?? ''} ${sender?.lastName ?? ''}`.trim(),
      content: body.content.slice(0, 100),
    });
    sendToAgent(conv.userB, 'chat:dm_notify', {
      conversationId,
      senderName: `${sender?.firstName ?? ''} ${sender?.lastName ?? ''}`.trim(),
      content: body.content.slice(0, 100),
    });
  }

  return c.json(row, 201);
});

// Get DM thread replies
router.get('/dm/:id/messages/:msgId/thread', async (c) => {
  const userId = c.get('user').sub;
  const conversationId = c.req.param('id');
  const msgId = c.req.param('msgId');

  const [conv] = await db.select().from(dmConversations)
    .where(and(
      eq(dmConversations.id, conversationId),
      or(eq(dmConversations.userA, userId), eq(dmConversations.userB, userId)),
    ));
  if (!conv) throw new NotFound('Conversation not found');

  const raw = paginationSchema.parse(c.req.query());
  const { offset, limit } = paginate(raw);

  const where = and(
    eq(dmMessages.conversationId, conversationId),
    eq(dmMessages.parentId, msgId),
  );

  const [rows, [{ total }]] = await Promise.all([
    db.select({
      id: dmMessages.id,
      conversationId: dmMessages.conversationId,
      senderId: dmMessages.senderId,
      content: dmMessages.content,
      parentId: dmMessages.parentId,
      fileUrl: dmMessages.fileUrl,
      fileName: dmMessages.fileName,
      fileSize: dmMessages.fileSize,
      fileType: dmMessages.fileType,
      createdAt: dmMessages.createdAt,
      senderFirstName: users.firstName,
      senderLastName: users.lastName,
    }).from(dmMessages)
      .leftJoin(users, eq(dmMessages.senderId, users.id))
      .where(where)
      .orderBy(asc(dmMessages.createdAt))
      .limit(limit).offset(offset),
    db.select({ total: count() }).from(dmMessages).where(where),
  ]);

  return c.json(paginatedResponse(rows, Number(total), raw));
});

// Mark DM conversation as read
router.post('/dm/:id/read', async (c) => {
  const userId = c.get('user').sub;
  const conversationId = c.req.param('id');

  await db.insert(chatReadMarkers).values({
    userId,
    conversationId,
    lastReadAt: new Date(),
  }).onConflictDoUpdate({
    target: [chatReadMarkers.userId, chatReadMarkers.conversationId],
    set: { lastReadAt: new Date() },
  });

  return c.json({ success: true });
});

// ─── File upload ──────────────────────────────────────────────────────────────

router.post('/upload', async (c) => {
  const tenantId = c.get('tenantId')!;

  const formData = await c.req.formData();
  const file = formData.get('file') as File | null;
  if (!file) throw new BadRequest('No file provided');

  const buffer = Buffer.from(await file.arrayBuffer());
  const key = `chat/${tenantId}/${Date.now()}-${file.name}`;

  await uploadFile(key, buffer, file.type);
  const url = await getFileUrl(key);

  return c.json({
    url,
    key,
    fileName: file.name,
    fileSize: file.size,
    fileType: file.type,
  });
});

// ─── DM users (keep existing) ────────────────────────────────────────────────

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

  return c.json({ data: tenantUsers.filter((u) => u.id !== userId) });
});

// ─── Reactions (polymorphic: channel message or DM message) ───────────────────

const reactionBody = z.object({ emoji: z.string().min(1).max(16) });

async function loadReactions(messageType: 'channel' | 'dm', messageIds: string[]) {
  if (messageIds.length === 0) return new Map<string, { emoji: string; count: number; users: string[]; mine: boolean }[]>();
  const rows = await db.select({
    messageId: chatReactions.messageId,
    emoji: chatReactions.emoji,
    userId: chatReactions.userId,
  }).from(chatReactions)
    .where(and(eq(chatReactions.messageType, messageType), inArray(chatReactions.messageId, messageIds)));

  const out = new Map<string, { emoji: string; count: number; users: string[] }[]>();
  for (const r of rows) {
    const list = out.get(r.messageId) ?? [];
    let item = list.find((x) => x.emoji === r.emoji);
    if (!item) { item = { emoji: r.emoji, count: 0, users: [] }; list.push(item); }
    item.count += 1;
    item.users.push(r.userId);
    out.set(r.messageId, list);
  }
  return out;
}

// POST /messages/:msgId/reactions — add/remove (toggle)
router.post('/messages/:msgId/reactions', async (c) => {
  const userId = c.get('user').sub;
  const msgId = c.req.param('msgId');
  const { emoji } = reactionBody.parse(await c.req.json());

  // Detect whether this is a channel or DM message
  const [chMsg] = await db.select({ id: chatMessages.id, channelId: chatMessages.channelId })
    .from(chatMessages).where(eq(chatMessages.id, msgId));
  const [dmMsg] = chMsg ? [undefined] : await db.select({ id: dmMessages.id, conversationId: dmMessages.conversationId })
    .from(dmMessages).where(eq(dmMessages.id, msgId));
  const type: 'channel' | 'dm' | null = chMsg ? 'channel' : dmMsg ? 'dm' : null;
  if (!type) throw new NotFound('Message not found');

  // Toggle: if exists, remove; else add.
  const [existing] = await db.select({ id: chatReactions.id }).from(chatReactions)
    .where(and(
      eq(chatReactions.messageType, type),
      eq(chatReactions.messageId, msgId),
      eq(chatReactions.userId, userId),
      eq(chatReactions.emoji, emoji),
    ));

  if (existing) {
    await db.delete(chatReactions).where(eq(chatReactions.id, existing.id));
  } else {
    await db.insert(chatReactions).values({ messageType: type, messageId: msgId, userId, emoji });
  }

  // Broadcast to the right room
  const room = chMsg ? `chat:${chMsg.channelId}` : `dm:${dmMsg!.conversationId}`;
  const event = chMsg ? 'chat:reaction' : 'chat:dm_reaction';
  broadcastToRoom(room, event, {
    messageId: msgId,
    emoji,
    userId,
    action: existing ? 'removed' : 'added',
  });

  return c.json({ ok: true, action: existing ? 'removed' : 'added' });
});

// GET /messages/:msgId/reactions — list reactions on a single message
router.get('/messages/:msgId/reactions', async (c) => {
  const msgId = c.req.param('msgId');
  const [chMsg] = await db.select({ id: chatMessages.id }).from(chatMessages).where(eq(chatMessages.id, msgId));
  const type: 'channel' | 'dm' = chMsg ? 'channel' : 'dm';
  const map = await loadReactions(type, [msgId]);
  return c.json({ data: map.get(msgId) ?? [] });
});

export { loadReactions };
export default router;
