import { pgTable, uuid, text, integer, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { voicebotConfigs } from './voicebot-configs';

export const voicebotIntents = pgTable('voicebot_intents', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  voicebotConfigId: uuid('voicebot_config_id').notNull().references(() => voicebotConfigs.id),
  name: text('name').notNull(),
  description: text('description'),
  trainingPhrases: text('training_phrases').array().default([]),
  action: text('action').notNull(),
  responseTemplate: text('response_template'),
  sortOrder: integer('sort_order').default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});
