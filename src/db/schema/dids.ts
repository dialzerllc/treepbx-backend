import { pgTable, uuid, text, numeric, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { platformDids } from './platform-dids';

export const dids = pgTable('dids', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  platformDidId: uuid('platform_did_id').references(() => platformDids.id),
  number: text('number').notNull(),
  description: text('description'),
  country: text('country').default('US'),
  city: text('city'),
  state: text('state'),
  didType: text('did_type').default('local'),
  didGroupId: uuid('did_group_id'),
  byocCarrierId: uuid('byoc_carrier_id'),
  active: boolean('active').default(true),
  routeType: text('route_type').default('ivr'),
  routeTargetId: uuid('route_target_id'),
  unknownCallerRoute: text('unknown_caller_route'),
  repeatCallerRoute: text('repeat_caller_route'),
  monthlyCost: numeric('monthly_cost', { precision: 8, scale: 4 }).default('0'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  index('idx_dids_tenant').on(table.tenantId),
]);
