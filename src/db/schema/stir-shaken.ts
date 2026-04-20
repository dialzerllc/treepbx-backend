import { pgTable, uuid, text, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { dids } from './dids';

export const stirCertificates = pgTable('stir_certificates', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  name: text('name').notNull(),
  certificateAuthority: text('certificate_authority').notNull(),
  spCode: text('sp_code'),
  certPem: text('cert_pem').notNull(),
  privateKeyHash: text('private_key_hash'),
  issuedAt: timestamp('issued_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  autoRenew: boolean('auto_renew').default(false),
  active: boolean('active').default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

export const stirDidAttestations = pgTable('stir_did_attestations', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  didId: uuid('did_id').notNull().references(() => dids.id),
  certificateId: uuid('certificate_id').notNull().references(() => stirCertificates.id),
  attestation: text('attestation').notNull().default('A'),
  verified: boolean('verified').default(false),
  lastSignedAt: timestamp('last_signed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  index('idx_stir_attestation_tenant').on(table.tenantId),
  index('idx_stir_attestation_did').on(table.didId),
]);
