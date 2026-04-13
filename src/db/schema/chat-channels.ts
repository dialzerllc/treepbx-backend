import { pgTable, uuid, text, timestamp, primaryKey, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { users } from './users';

export const chatChannels = pgTable('chat_channels', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  name: text('name').notNull(),
  type: text('type').default('group'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const chatChannelMembers = pgTable('chat_channel_members', {
  channelId: uuid('channel_id').notNull().references(() => chatChannels.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id),
  joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.channelId, table.userId] }),
]);
