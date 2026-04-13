import { pgTable, text, primaryKey } from 'drizzle-orm/pg-core';

export const npaNxx = pgTable('npa_nxx', {
  npa: text('npa').notNull(),
  nxx: text('nxx').notNull(),
  state: text('state'),
  city: text('city'),
  county: text('county'),
  timezone: text('timezone'),
  rateCenter: text('rate_center'),
  carrier: text('carrier'),
  lineType: text('line_type'),
}, (table) => [
  primaryKey({ columns: [table.npa, table.nxx] }),
]);
