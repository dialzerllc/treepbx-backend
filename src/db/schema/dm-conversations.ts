import { pgTable, uuid, text, timestamp, integer, index, unique } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { users } from './users';

export const dmConversations = pgTable('dm_conversations', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  userA: uuid('user_a').notNull().references(() => users.id),
  userB: uuid('user_b').notNull().references(() => users.id),
  lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  unique().on(table.userA, table.userB),
]);

export const dmMessages = pgTable('dm_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  conversationId: uuid('conversation_id').notNull().references(() => dmConversations.id, { onDelete: 'cascade' }),
  senderId: uuid('sender_id').notNull().references(() => users.id),
  content: text('content').notNull(),
  parentId: uuid('parent_id'),
  fileUrl: text('file_url'),
  fileName: text('file_name'),
  fileSize: integer('file_size'),
  fileType: text('file_type'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  index('idx_dm_messages_conv').on(table.conversationId, table.createdAt),
]);

export const chatReadMarkers = pgTable('chat_read_markers', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  channelId: uuid('channel_id'),
  conversationId: uuid('conversation_id'),
  lastReadAt: timestamp('last_read_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  unique().on(table.userId, table.channelId),
  unique().on(table.userId, table.conversationId),
]);
