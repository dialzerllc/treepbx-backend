import { pgTable, uuid, text, integer, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { users } from './users';
import { tenants } from './tenants';

// Centralised error capture for the super-admin debugger page.
// Server unhandled errors (from Hono's onError) and client-reported errors
// (window.onerror / unhandledrejection POSTed to /platform/debug/client-error)
// both land here. Pruned periodically; not a long-term audit trail.
export const errorLog = pgTable('error_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  level: text('level').notNull(),                          // 'error' | 'warn'
  source: text('source').notNull().default('server'),      // 'server' | 'client'
  method: text('method'),
  path: text('path'),
  statusCode: integer('status_code'),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'set null' }),
  errType: text('err_type'),
  errMessage: text('err_message').notNull(),
  stack: text('stack'),
  context: jsonb('context').default({}),                   // request id, user agent, extra
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  index('idx_error_log_created').on(table.createdAt),
  index('idx_error_log_source_level').on(table.source, table.level, table.createdAt),
]);
