import { pgTable, uuid, text, numeric, bigint, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const audioFiles = pgTable('audio_files', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  name: text('name').notNull(),
  description: text('description'),
  minioKey: text('minio_key').notNull(),
  durationSeconds: numeric('duration_seconds', { precision: 8, scale: 2 }),
  format: text('format').default('wav'),
  sizeBytes: bigint('size_bytes', { mode: 'number' }),
  source: text('source').default('upload'),
  ttsText: text('tts_text'),
  ttsVoice: text('tts_voice'),
  category: text('category').default('general'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});
