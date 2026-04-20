import { pgTable, uuid, text, integer, numeric, boolean, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const serviceMetricTargets = pgTable('service_metric_targets', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  name: text('name').notNull(),
  description: text('description'),
  // Call Targets
  answerTimeSeconds: integer('answer_time_seconds').default(20),
  serviceLevelPct: integer('service_level_pct').default(80),
  maxWaitSeconds: integer('max_wait_seconds').default(120),
  maxAbandonPct: integer('max_abandon_pct').default(5),
  avgHandleTimeSeconds: integer('avg_handle_time_seconds').default(300),
  avgWrapTimeSeconds: integer('avg_wrap_time_seconds').default(30),
  minAnswerRatePct: integer('min_answer_rate_pct').default(90),
  // Agent Targets
  maxHoldTimeSeconds: integer('max_hold_time_seconds').default(60),
  maxRingTimeSeconds: integer('max_ring_time_seconds').default(30),
  minOccupancyPct: integer('min_occupancy_pct').default(60),
  maxIdleTimeSeconds: integer('max_idle_time_seconds').default(300),
  // Quality Targets
  minMosScore: numeric('min_mos_score', { precision: 3, scale: 1 }).default('3.5'),
  maxCallsPerHour: integer('max_calls_per_hour').default(0),
  firstCallResolutionPct: integer('first_call_resolution_pct').default(70),
  // Assignment
  assignedType: text('assigned_type').default('global'),
  assignedId: uuid('assigned_id'),
  active: boolean('active').default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});
