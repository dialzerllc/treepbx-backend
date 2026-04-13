import { pgTable, uuid, text, integer, jsonb, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { calls } from './calls';

export const voicebotConversations = pgTable('voicebot_conversations', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  callId: uuid('call_id').references(() => calls.id),
  voicebotConfigId: uuid('voicebot_config_id').notNull(),
  turns: jsonb('turns').default([]),
  outcome: text('outcome'),
  rating: integer('rating'),
  durationSeconds: integer('duration_seconds'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});
