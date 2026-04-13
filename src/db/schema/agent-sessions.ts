import { pgTable, uuid, integer, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { users } from './users';

export const agentSessions = pgTable('agent_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  agentId: uuid('agent_id').notNull().references(() => users.id),
  campaignId: uuid('campaign_id'),
  loginAt: timestamp('login_at', { withTimezone: true }).notNull().defaultNow(),
  logoutAt: timestamp('logout_at', { withTimezone: true }),
  totalCalls: integer('total_calls').default(0),
  totalTalkSeconds: integer('total_talk_seconds').default(0),
  totalWrapSeconds: integer('total_wrap_seconds').default(0),
  totalBreakSeconds: integer('total_break_seconds').default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});
