import { Hono } from 'hono';
import { z } from 'zod';
import { eq, isNull } from 'drizzle-orm';
import { db } from '../../db/client';
import { tenants } from '../../db/schema';
import { NotFound } from '../../lib/errors';
import { requireRole } from '../../middleware/roles';

const router = new Hono();

const settingsUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  billingEmail: z.string().email().optional(),
  timezone: z.string().optional(),
  domain: z.string().optional(),
  phone: z.string().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  country: z.string().optional(),
  industry: z.string().optional(),
  customerType: z.string().optional(),
  features: z.record(z.unknown()).optional(),
  logoUrl: z.string().url().optional(),
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

// Get current plan
router.get('/plan', async (c) => {
  const tenantId = c.get('tenantId')!;
  const [row] = await db.select({
    planId: tenants.planId,
    status: tenants.status,
    maxAgents: tenants.maxAgents,
    maxConcurrentCalls: tenants.maxConcurrentCalls,
    maxDids: tenants.maxDids,
    features: tenants.features,
  }).from(tenants).where(eq(tenants.id, tenantId));
  if (!row) throw new NotFound('Tenant not found');
  return c.json(row);
});

// Plan upgrade - placeholder
router.post('/plan/upgrade', requireRole('tenant_admin'), async (c) => {
  const body = z.object({ planId: z.string().uuid() }).parse(await c.req.json());
  return c.json({ ok: true, message: 'Plan upgrade requested', planId: body.planId }, 202);
});

export default router;
