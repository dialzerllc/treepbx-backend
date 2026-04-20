import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, desc, count, sql } from 'drizzle-orm';
import { db } from '../../db/client';
import { stirCertificates, stirDidAttestations, dids } from '../../db/schema';
import { NotFound, BadRequest } from '../../lib/errors';
import { requireRole } from '../../middleware/roles';

const router = new Hono();

// ─── Certificates ───────────────────────────────────────────────────────────

// List certificates
router.get('/certificates', async (c) => {
  const tenantId = c.get('tenantId')!;
  const rows = await db.select().from(stirCertificates)
    .where(eq(stirCertificates.tenantId, tenantId))
    .orderBy(desc(stirCertificates.createdAt));
  return c.json({ data: rows });
});

// Get active certificate
router.get('/certificates/active', async (c) => {
  const tenantId = c.get('tenantId')!;
  const [row] = await db.select().from(stirCertificates)
    .where(and(eq(stirCertificates.tenantId, tenantId), eq(stirCertificates.active, true)))
    .limit(1);
  return c.json(row || null);
});

// Add certificate
const certSchema = z.object({
  name: z.string().min(1),
  certificateAuthority: z.string().min(1),
  spCode: z.string().nullable().optional(),
  certPem: z.string().min(1),
  privateKeyPem: z.string().optional(),
  issuedAt: z.string().nullable().optional().transform((v) => v ? new Date(v) : null),
  expiresAt: z.string().nullable().optional().transform((v) => v ? new Date(v) : null),
  autoRenew: z.boolean().default(false),
});

router.post('/certificates', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = certSchema.parse(await c.req.json());
  const [dup] = await db.select({ id: stirCertificates.id }).from(stirCertificates)
    .where(and(eq(stirCertificates.name, body.name), eq(stirCertificates.tenantId, tenantId)));
  if (dup) throw new BadRequest('Certificate name already exists');

  // Hash the private key if provided (don't store raw)
  let privateKeyHash: string | undefined;
  if (body.privateKeyPem) {
    const { hashPassword } = await import('../../lib/password');
    privateKeyHash = await hashPassword(body.privateKeyPem.slice(0, 64));
  }

  // Deactivate existing active certificates
  await db.update(stirCertificates)
    .set({ active: false })
    .where(and(eq(stirCertificates.tenantId, tenantId), eq(stirCertificates.active, true)));

  const [row] = await db.insert(stirCertificates).values({
    tenantId,
    name: body.name,
    certificateAuthority: body.certificateAuthority,
    spCode: body.spCode,
    certPem: body.certPem,
    privateKeyHash,
    issuedAt: body.issuedAt,
    expiresAt: body.expiresAt,
    autoRenew: body.autoRenew,
    active: true,
  }).returning();

  return c.json(row, 201);
});

// Update certificate
router.put('/certificates/:id', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = z.object({
    name: z.string().min(1).optional(),
    autoRenew: z.boolean().optional(),
    active: z.boolean().optional(),
  }).parse(await c.req.json());
  if (body.name) {
    const [dup] = await db.select({ id: stirCertificates.id }).from(stirCertificates)
      .where(and(eq(stirCertificates.name, body.name), eq(stirCertificates.tenantId, tenantId), sql`${stirCertificates.id} != ${c.req.param('id')}`));
    if (dup) throw new BadRequest('Certificate name already exists');
  }

  // If activating, deactivate others first
  if (body.active) {
    await db.update(stirCertificates)
      .set({ active: false })
      .where(and(eq(stirCertificates.tenantId, tenantId), eq(stirCertificates.active, true)));
  }

  const [row] = await db.update(stirCertificates)
    .set({ ...body, updatedAt: new Date() })
    .where(and(eq(stirCertificates.id, c.req.param('id')), eq(stirCertificates.tenantId, tenantId)))
    .returning();
  if (!row) throw new NotFound('Certificate not found');
  return c.json(row);
});

// Delete certificate
router.delete('/certificates/:id', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  // Delete attestations linked to this cert
  await db.delete(stirDidAttestations)
    .where(and(eq(stirDidAttestations.certificateId, c.req.param('id')), eq(stirDidAttestations.tenantId, tenantId)));
  const [row] = await db.delete(stirCertificates)
    .where(and(eq(stirCertificates.id, c.req.param('id')), eq(stirCertificates.tenantId, tenantId)))
    .returning();
  if (!row) throw new NotFound('Certificate not found');
  return c.json({ ok: true });
});

// ─── DID Attestations ───────────────────────────────────────────────────────

// Get attestations for all DIDs
router.get('/attestations', async (c) => {
  const tenantId = c.get('tenantId')!;
  const rows = await db.select({
    id: stirDidAttestations.id,
    didId: stirDidAttestations.didId,
    certificateId: stirDidAttestations.certificateId,
    attestation: stirDidAttestations.attestation,
    verified: stirDidAttestations.verified,
    lastSignedAt: stirDidAttestations.lastSignedAt,
    didNumber: dids.number,
    didCountry: dids.country,
  }).from(stirDidAttestations)
    .innerJoin(dids, eq(dids.id, stirDidAttestations.didId))
    .where(eq(stirDidAttestations.tenantId, tenantId))
    .orderBy(desc(stirDidAttestations.createdAt));
  return c.json({ data: rows });
});

// Set attestation for a DID
const attestationSchema = z.object({
  didId: z.string().uuid(),
  attestation: z.enum(['A', 'B', 'C']).default('A'),
});

router.post('/attestations', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = attestationSchema.parse(await c.req.json());

  // Get active certificate
  const [cert] = await db.select({ id: stirCertificates.id }).from(stirCertificates)
    .where(and(eq(stirCertificates.tenantId, tenantId), eq(stirCertificates.active, true)));
  if (!cert) return c.json({ error: 'No active certificate. Upload a certificate first.' }, 400);

  // Verify DID belongs to tenant
  const [did] = await db.select({ id: dids.id }).from(dids)
    .where(and(eq(dids.id, body.didId), eq(dids.tenantId, tenantId)));
  if (!did) throw new NotFound('DID not found');

  // Upsert attestation
  const [existing] = await db.select({ id: stirDidAttestations.id }).from(stirDidAttestations)
    .where(and(eq(stirDidAttestations.didId, body.didId), eq(stirDidAttestations.tenantId, tenantId)));

  if (existing) {
    const [row] = await db.update(stirDidAttestations)
      .set({ attestation: body.attestation, certificateId: cert.id })
      .where(eq(stirDidAttestations.id, existing.id))
      .returning();
    return c.json(row);
  }

  const [row] = await db.insert(stirDidAttestations).values({
    tenantId,
    didId: body.didId,
    certificateId: cert.id,
    attestation: body.attestation,
    verified: true,
  }).returning();
  return c.json(row, 201);
});

// Delete attestation
router.delete('/attestations/:id', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const [row] = await db.delete(stirDidAttestations)
    .where(and(eq(stirDidAttestations.id, c.req.param('id')), eq(stirDidAttestations.tenantId, tenantId)))
    .returning();
  if (!row) throw new NotFound('Attestation not found');
  return c.json({ ok: true });
});

// ─── Summary stats ──────────────────────────────────────────────────────────

router.get('/stats', async (c) => {
  const tenantId = c.get('tenantId')!;

  const [cert] = await db.select().from(stirCertificates)
    .where(and(eq(stirCertificates.tenantId, tenantId), eq(stirCertificates.active, true)));

  const attestations = await db.select({
    attestation: stirDidAttestations.attestation,
    count: count(),
  }).from(stirDidAttestations)
    .where(eq(stirDidAttestations.tenantId, tenantId))
    .groupBy(stirDidAttestations.attestation);

  const statsMap = Object.fromEntries(attestations.map((a) => [a.attestation, Number(a.count)]));

  return c.json({
    certificate: cert ? {
      id: cert.id,
      name: cert.name,
      certificateAuthority: cert.certificateAuthority,
      spCode: cert.spCode,
      issuedAt: cert.issuedAt,
      expiresAt: cert.expiresAt,
      autoRenew: cert.autoRenew,
      active: cert.active,
    } : null,
    attestationCounts: {
      A: statsMap['A'] ?? 0,
      B: statsMap['B'] ?? 0,
      C: statsMap['C'] ?? 0,
    },
  });
});

export default router;
