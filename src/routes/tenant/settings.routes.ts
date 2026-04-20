import { Hono } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../../db/client';
import { tenants, plans, rateGroups, rateCards } from '../../db/schema';
import { NotFound } from '../../lib/errors';
import { requireRole } from '../../middleware/roles';
import { optionalEmail } from '../../lib/zod-helpers';

const router = new Hono();

const settingsUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  billingEmail: optionalEmail(),
  timezone: z.string().nullable().optional(),
  domain: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  industry: z.string().nullable().optional(),
  customerType: z.string().nullable().optional(),
  features: z.record(z.unknown()).optional(),
  logoUrl: z.string().optional().transform((v) => v && v.startsWith('http') ? v : undefined),
});

// Get tenant settings
router.get('/', async (c) => {
  const tenantId = c.get('tenantId')!;
  const [row] = await db.select({
    id: tenants.id,
    name: tenants.name,
    slug: tenants.slug,
    status: tenants.status,
    planId: tenants.planId,
    maxAgents: tenants.maxAgents,
    maxConcurrentCalls: tenants.maxConcurrentCalls,
    maxDids: tenants.maxDids,
    logoUrl: tenants.logoUrl,
    timezone: tenants.timezone,
    domain: tenants.domain,
    billingEmail: tenants.billingEmail,
    customerType: tenants.customerType,
    industry: tenants.industry,
    phone: tenants.phone,
    address: tenants.address,
    city: tenants.city,
    state: tenants.state,
    country: tenants.country,
    features: tenants.features,
    createdAt: tenants.createdAt,
    updatedAt: tenants.updatedAt,
  }).from(tenants).where(eq(tenants.id, tenantId));
  if (!row) throw new NotFound('Tenant not found');
  return c.json(row);
});

// Update tenant settings
router.put('/', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = settingsUpdateSchema.parse(await c.req.json());
  const [row] = await db.update(tenants)
    .set({ ...body, updatedAt: new Date() })
    .where(eq(tenants.id, tenantId))
    .returning();
  if (!row) throw new NotFound('Tenant not found');
  return c.json(row);
});

// Get current plan with SLA and rate group
router.get('/plan', async (c) => {
  const tenantId = c.get('tenantId')!;
  const [tenant] = await db.select({
    planId: tenants.planId,
    status: tenants.status,
    maxAgents: tenants.maxAgents,
    maxConcurrentCalls: tenants.maxConcurrentCalls,
    maxDids: tenants.maxDids,
    features: tenants.features,
  }).from(tenants).where(eq(tenants.id, tenantId));
  if (!tenant) throw new NotFound('Tenant not found');

  let planData: Record<string, unknown> = {};
  let rateGroupData: Record<string, unknown> | undefined;

  if (tenant.planId) {
    const [plan] = await db.select().from(plans).where(eq(plans.id, tenant.planId));
    if (plan) {
      planData = {
        name: plan.name,
        priceMonthly: Number(plan.priceMonthly),
        priceYearly: Number(plan.priceYearly),
        features: plan.features ?? [],
        slaUptimePct: plan.slaUptimePct,
        slaResponseMinutes: plan.slaResponseMinutes,
        slaResolutionHours: plan.slaResolutionHours,
        slaSupportHours: plan.slaSupportHours,
        slaPriorityRouting: plan.slaPriorityRouting,
        slaDedicatedManager: plan.slaDedicatedManager,
        slaCustomIntegrations: plan.slaCustomIntegrations,
      };

      // Fetch rate group if attached to plan
      if (plan.rateGroupId) {
        const [rg] = await db.select().from(rateGroups).where(eq(rateGroups.id, plan.rateGroupId));
        if (rg) {
          const cards = await db.select().from(rateCards).where(eq(rateCards.rateGroupId, rg.id));
          rateGroupData = {
            id: rg.id,
            name: rg.name,
            currency: rg.currency,
            inboundBillingIncrement: rg.inboundBillingIncrement,
            outboundBillingIncrement: rg.outboundBillingIncrement,
            recordingRate: Number(rg.recordingRate ?? 0),
            voicebotRate: Number(rg.voicebotRate ?? 0),
            byocRate: Number(rg.byocRate ?? 0),
            storageRate: Number(rg.storageRate ?? 0),
            inboundRates: cards.filter((c) => c.direction === 'inbound').map((c) => ({
              country: c.country, code: c.countryCode, billingIncrement: c.billingIncrement || '6/6', rate: Number(c.ratePerMinute),
            })),
            outboundRates: cards.filter((c) => c.direction === 'outbound').map((c) => ({
              country: c.country, code: c.countryCode, billingIncrement: c.billingIncrement || '6/6', rate: Number(c.ratePerMinute),
            })),
          };
        }
      }
    }
  }

  return c.json({
    id: tenant.planId,
    ...planData,
    maxAgents: tenant.maxAgents,
    maxConcurrentCalls: tenant.maxConcurrentCalls,
    maxDids: tenant.maxDids,
    rateGroup: rateGroupData,
  });
});

// Plan upgrade
router.post('/plan/upgrade', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = z.object({ planId: z.string().uuid() }).passthrough().parse(await c.req.json());

  // Fetch the target plan
  const [plan] = await db.select().from(plans).where(eq(plans.id, body.planId));
  if (!plan) throw new NotFound('Plan not found');

  // Update tenant with new plan limits
  const [updated] = await db.update(tenants)
    .set({
      planId: plan.id,
      maxAgents: plan.maxAgents,
      maxConcurrentCalls: plan.maxConcurrentCalls,
      maxDids: plan.maxDids,
      features: plan.features,
      updatedAt: new Date(),
    })
    .where(eq(tenants.id, tenantId))
    .returning();

  return c.json({ ok: true, plan: plan.name, tenant: updated });
});

export default router;
