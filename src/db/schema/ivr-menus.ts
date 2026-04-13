import { pgTable, uuid, text, integer, boolean, timestamp, unique } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const ivrMenus = pgTable('ivr_menus', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  name: text('name').notNull(),
  welcomeAudioId: uuid('welcome_audio_id'),
  timeoutSeconds: integer('timeout_seconds').default(5),
  maxRetries: integer('max_retries').default(3),
  invalidAudioId: uuid('invalid_audio_id'),
  timeoutAudioId: uuid('timeout_audio_id'),
  timeoutAction: text('timeout_action').default('hangup'),
  timeoutTargetId: uuid('timeout_target_id'),
  afterHoursEnabled: boolean('after_hours_enabled').default(false),
  afterHoursProfileId: uuid('after_hours_profile_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const ivrMenuActions = pgTable('ivr_menu_actions', {
  id: uuid('id').primaryKey().defaultRandom(),
  ivrMenuId: uuid('ivr_menu_id').notNull().references(() => ivrMenus.id, { onDelete: 'cascade' }),
  dtmfKey: text('dtmf_key').notNull(),
  actionType: text('action_type').notNull(),
  targetId: uuid('target_id'),
  targetNumber: text('target_number'),
  audioId: uuid('audio_id'),
  label: text('label'),
}, (table) => [
  unique('uq_ivr_dtmf').on(table.ivrMenuId, table.dtmfKey),
]);
