import { pgTable, uuid, text, integer, bigint, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { calls } from './calls';

export const callRecordings = pgTable('call_recordings', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  callId: uuid('call_id').notNull().references(() => calls.id, { onDelete: 'cascade' }),
  minioKey: text('minio_key').notNull(),
  format: text('format').default('wav'),
  durationSeconds: integer('duration_seconds'),
  sizeBytes: bigint('size_bytes', { mode: 'number' }),
  transcript: text('transcript'),
  transcriptStatus: text('transcript_status').default('pending'),
  summary: text('summary'),
  summaryStatus: text('summary_status').default('pending'),
  fraudScanStatus: text('fraud_scan_status').default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});
