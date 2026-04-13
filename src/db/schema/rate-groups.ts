import { pgTable, uuid, text, numeric, date, timestamp } from 'drizzle-orm/pg-core';
import { carriers } from './carriers';

export const rateGroups = pgTable('rate_groups', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  inboundCarrierId: uuid('inbound_carrier_id').references(() => carriers.id),
  outboundCarrierId: uuid('outbound_carrier_id').references(() => carriers.id),
  currency: text('currency').default('USD'),
  inboundBillingIncrement: text('inbound_billing_increment').default('1/1'),
  outboundBillingIncrement: text('outbound_billing_increment').default('6/6'),
  featureBillingIncrement: text('feature_billing_increment').default('6/6'),
  recordingRate: numeric('recording_rate', { precision: 8, scale: 6 }).default('0.002'),
  voicebotRate: numeric('voicebot_rate', { precision: 8, scale: 6 }).default('0.015'),
  byocRate: numeric('byoc_rate', { precision: 8, scale: 6 }).default('0.008'),
  storageRate: numeric('storage_rate', { precision: 8, scale: 6 }).default('0.10'),
  effectiveDate: date('effective_date').notNull().defaultNow(),
  status: text('status').default('draft'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});
