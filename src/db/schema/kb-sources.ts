import { pgTable, uuid, text, integer, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { voicebotConfigs } from './voicebot-configs';

export const kbSources = pgTable('kb_sources', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  voicebotConfigId: uuid('voicebot_config_id').notNull().references(() => voicebotConfigs.id),
  name: text('name').notNull(),
  sourceType: text('source_type').notNull(),
  sourceUrl: text('source_url'),
  minioKey: text('minio_key'),
  question: text('question'),
  answer: text('answer'),
  status: text('status').default('pending'),
  chunkCount: integer('chunk_count').default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});
