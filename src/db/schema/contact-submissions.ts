import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';

export const contactSubmissions = pgTable('contact_submissions', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  company: text('company'),
  agents: text('agents'),
  message: text('message'),
  ip: text('ip'),
  userAgent: text('user_agent'),
  consentAt: timestamp('consent_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => [
  index('idx_contact_submissions_email').on(t.email, t.createdAt),
  index('idx_contact_submissions_ip').on(t.ip, t.createdAt),
]);
