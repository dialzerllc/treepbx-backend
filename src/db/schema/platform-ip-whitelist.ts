import { pgTable, uuid, text, boolean, timestamp } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * Platform-level IP allowlist used to restrict admin/supervisor login to
 * specific CIDR blocks. Enforcement is gated on the `platform_ip_whitelist_enabled`
 * platform_setting so an empty list never accidentally locks ops out.
 */
export const platformIpWhitelist = pgTable('platform_ip_whitelist', {
  id: uuid('id').primaryKey().defaultRandom(),
  cidr: text('cidr').notNull(),
  label: text('label'),
  enabled: boolean('enabled').default(true).notNull(),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});
