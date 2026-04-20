import { pgTable, uuid, text, integer, boolean, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { users } from './users';

export const teams = pgTable('teams', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  name: text('name').notNull(),
  description: text('description'),
  supervisorId: uuid('supervisor_id').references(() => users.id),
  scriptId: uuid('script_id'),
  skills: text('skills').array().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const queues = pgTable('queues', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  teamId: uuid('team_id').references(() => teams.id),
  name: text('name').notNull(),
  strategy: text('strategy').default('longest_idle'),
  maxWaitSeconds: integer('max_wait_seconds').default(300),
  announcePosition: boolean('announce_position').default(true),
  announceIntervalSeconds: integer('announce_interval_seconds').default(30),
  maxQueueSize: integer('max_queue_size').default(50),
  musicOnHoldId: uuid('music_on_hold_id'),
  timeoutDestination: text('timeout_destination'),
  afterHoursEnabled: boolean('after_hours_enabled').default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});
