import { pgTable, uuid, text, numeric, timestamp, unique } from 'drizzle-orm/pg-core';
import { rateGroups } from './rate-groups';

export const rateCards = pgTable('rate_cards', {
  id: uuid('id').primaryKey().defaultRandom(),
  rateGroupId: uuid('rate_group_id').notNull().references(() => rateGroups.id, { onDelete: 'cascade' }),
  country: text('country').notNull(),
  countryCode: text('country_code').notNull(),
  direction: text('direction').notNull(),
  ratePerMinute: numeric('rate_per_minute', { precision: 10, scale: 6 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  unique('uq_rate_card').on(table.rateGroupId, table.countryCode, table.direction),
]);
