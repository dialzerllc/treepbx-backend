import { pgTable, uuid, text, timestamp, index, unique } from 'drizzle-orm/pg-core';
import { users } from './users';

// Polymorphic reactions table: `messageType` distinguishes channel vs DM.
export const chatReactions = pgTable('chat_reactions', {
  id: uuid('id').primaryKey().defaultRandom(),
  messageType: text('message_type').notNull(),
  messageId: uuid('message_id').notNull(),
  userId: uuid('user_id').notNull().references(() => users.id),
  emoji: text('emoji').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  index('idx_chat_reactions_message').on(table.messageType, table.messageId),
  unique('uniq_reaction_per_user_emoji').on(table.messageType, table.messageId, table.userId, table.emoji),
]);
