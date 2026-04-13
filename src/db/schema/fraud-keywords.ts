import { pgTable, uuid, text, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { users } from './users';
import { calls } from './calls';

export const fraudKeywords = pgTable('fraud_keywords', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id),
  keyword: text('keyword').notNull(),
  category: text('category').notNull(),
  severity: text('severity').default('warning'),
  isPhrase: boolean('is_phrase').default(false),
  isRegex: boolean('is_regex').default(false),
  notifyEmail: boolean('notify_email').default(true),
  notifySms: boolean('notify_sms').default(false),
  notifyWebhook: boolean('notify_webhook').default(false),
  notifyInApp: boolean('notify_in_app').default(true),
  escalateToSupervisor: boolean('escalate_to_supervisor').default(false),
  autoRecordCall: boolean('auto_record_call').default(false),
  active: boolean('active').default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const fraudAlerts = pgTable('fraud_alerts', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id),
  callId: uuid('call_id').references(() => calls.id),
  agentId: uuid('agent_id').references(() => users.id),
  fraudKeywordId: uuid('fraud_keyword_id').references(() => fraudKeywords.id),
  keyword: text('keyword').notNull(),
  phraseContext: text('phrase_context'),
  severity: text('severity').notNull(),
  caller: text('caller'),
  source: text('source').default('live'),
  status: text('status').default('new'),
  reviewedBy: uuid('reviewed_by').references(() => users.id),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  index('idx_fraud_alerts').on(table.tenantId, table.status, table.createdAt),
]);
