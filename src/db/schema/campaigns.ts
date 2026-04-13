import { pgTable, uuid, text, integer, numeric, boolean, time, timestamp, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { users } from './users';

export const campaigns = pgTable('campaigns', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  name: text('name').notNull(),
  status: text('status').default('draft'),
  dialMode: text('dial_mode').notNull().default('progressive'),
  leadListId: uuid('lead_list_id'),
  didGroupId: uuid('did_group_id'),
  voicebotConfigId: uuid('voicebot_config_id'),
  rateCardId: uuid('rate_card_id'),
  scriptId: uuid('script_id'),
  // Dialer
  dialRatio: numeric('dial_ratio', { precision: 4, scale: 2 }).default('1.0'),
  maxAbandonRate: numeric('max_abandon_rate', { precision: 5, scale: 2 }).default('3.0'),
  wrapUpSeconds: integer('wrap_up_seconds').default(30),
  ringTimeoutSeconds: integer('ring_timeout_seconds').default(25),
  // AMD
  amdEnabled: boolean('amd_enabled').default(false),
  amdTimeoutMs: integer('amd_timeout_ms').default(3500),
  amdAction: text('amd_action').default('hangup'),
  amdTransferTarget: text('amd_transfer_target'),
  // Recording
  recordingMode: text('recording_mode').default('all'),
  recordingFormat: text('recording_format').default('wav'),
  // BYOC
  byocRouting: text('byoc_routing').default('platform'),
  byocCarrierId: uuid('byoc_carrier_id'),
  // Schedule
  scheduledStart: timestamp('scheduled_start', { withTimezone: true }),
  scheduledEnd: timestamp('scheduled_end', { withTimezone: true }),
  dialingDays: text('dialing_days').array().default(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']),
  dialingStartTime: time('dialing_start_time').default('09:00'),
  dialingEndTime: time('dialing_end_time').default('17:00'),
  scheduleTimezone: text('schedule_timezone').default('America/New_York'),
  maxCallsPerDay: integer('max_calls_per_day').default(0),
  maxAttemptsPerLead: integer('max_attempts_per_lead').default(3),
  retryDelayMinutes: integer('retry_delay_minutes').default(60),
  respectLeadTimezone: boolean('respect_lead_timezone').default(true),
  pauseOnHolidays: boolean('pause_on_holidays').default(true),
  // Dispositions
  dispositionRequired: boolean('disposition_required').default(true),
  enabledDispositions: text('enabled_dispositions').array().default([]),
  // Transfer
  transferEnabled: boolean('transfer_enabled').default(false),
  transferType: text('transfer_type').default('blind'),
  transferDestType: text('transfer_dest_type').default('external'),
  transferTarget: text('transfer_target'),
  // Voicebot
  botQualifiedAction: text('bot_qualified_action'),
  botQualifiedTarget: text('bot_qualified_target'),
  // Meta
  createdBy: uuid('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  index('idx_campaigns_tenant').on(table.tenantId, table.status),
]);
