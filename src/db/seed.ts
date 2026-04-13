import { db } from './client';
import { users, tenants, plans, wallets } from './schema';
import { hashPassword } from '../lib/password';

async function seed() {
  console.log('Seeding database...');

  // Create a default plan
  const [starterPlan] = await db.insert(plans).values({
    name: 'Starter',
    slug: 'starter',
    priceMonthly: '49.00',
    priceYearly: '470.00',
    maxAgents: 10,
    maxConcurrentCalls: 20,
    maxDids: 5,
  }).returning();

  const [proPlan] = await db.insert(plans).values({
    name: 'Professional',
    slug: 'professional',
    priceMonthly: '149.00',
    priceYearly: '1430.00',
    maxAgents: 50,
    maxConcurrentCalls: 100,
    maxDids: 25,
    popular: true,
  }).returning();

  // Create demo tenant
  const [tenant] = await db.insert(tenants).values({
    name: 'Acme Corp',
    slug: 'acme',
    status: 'active',
    planId: proPlan.id,
    maxAgents: 50,
    maxConcurrentCalls: 100,
    maxDids: 25,
    timezone: 'America/New_York',
    features: {
      byoc_enabled: true,
      api_access: true,
      voicebot_enabled: true,
      crm_enabled: true,
      recording_enabled: true,
      fraud_enabled: true,
      chat_enabled: true,
    },
  }).returning();

  // Create wallet for tenant
  await db.insert(wallets).values({
    tenantId: tenant.id,
    balance: '500.0000',
    currency: 'USD',
  });

  // Seed demo users matching frontend DEMO_USERS
  const pw = await hashPassword('demo123');

  await db.insert(users).values([
    {
      email: 'admin@treepbx.com',
      passwordHash: pw,
      firstName: 'Super',
      lastName: 'Admin',
      role: 'super_admin',
    },
    {
      email: 'supervisor@treepbx.com',
      passwordHash: pw,
      firstName: 'Platform',
      lastName: 'Supervisor',
      role: 'platform_supervisor',
    },
    {
      email: 'tenant@acme.com',
      passwordHash: pw,
      firstName: 'Tenant',
      lastName: 'Admin',
      role: 'tenant_admin',
      tenantId: tenant.id,
    },
    {
      email: 'sup@acme.com',
      passwordHash: pw,
      firstName: 'Team',
      lastName: 'Supervisor',
      role: 'supervisor',
      tenantId: tenant.id,
    },
    {
      email: 'agent@acme.com',
      passwordHash: pw,
      firstName: 'John',
      lastName: 'Agent',
      role: 'agent',
      tenantId: tenant.id,
      sipUsername: 'agent1001',
      sipDomain: 'acme.treepbx.com',
    },
  ]);

  console.log('Seed complete. Demo login: any email above with password "demo123"');
  process.exit(0);
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
