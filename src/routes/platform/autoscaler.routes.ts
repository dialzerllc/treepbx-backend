import { Hono } from 'hono';
import { z } from 'zod';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { db } from '../../db/client';
import { mediaNodes, scalingDecisions, platformSettings, calls, tenants } from '../../db/schema';
import { observer } from '../../autoscaler/observer';
import { recommend, type FleetNode } from '../../autoscaler/recommender';
import { PROFILES, CATALOG, SPEC_BY_TYPE } from '../../autoscaler/catalog';
import { listServers, listDatacenters, listServerTypes } from '../../integrations/hetzner';
import { logger, getRecentLogs } from '../../lib/logger';

// Sentinel range for load-sim data. Real Hetzner server IDs are in the
// low millions; anything above 9e9 is a synthetic node we own.
const SIM_HETZNER_BASE = 9_000_000_000;
const SIM_CALLER_ID = '+10000000000';

const router = new Hono();

/**
 * GET /platform/autoscaler/fleet
 * Merges live Hetzner servers with our media_nodes state so the UI can see
 * both sides (what Hetzner has provisioned vs what our autoscaler tracks).
 *
 * Excludes the control plane and dev workstations, which share the Hetzner
 * project but are not autoscaler-managed. Filtered by Hetzner label
 * `role` ∈ {control-plane, developer-workstation} OR `env=dev`.
 */
router.get('/fleet', async (c) => {
  let hetznerServers: any[] = [];
  let hetznerError: string | null = null;
  try {
    const res = await listServers();
    hetznerServers = (res?.servers ?? []).filter((s: any) => {
      const labels = s?.labels ?? {};
      if (labels.role === 'control-plane' || labels.role === 'developer-workstation') return false;
      if (labels.env === 'dev') return false;
      return true;
    });
  } catch (err: any) {
    hetznerError = err?.message ?? String(err);
    logger.warn({ err }, '[autoscaler.routes] Hetzner listServers failed');
  }

  const nodes = await db.select().from(mediaNodes);
  const byHetznerId = new Map(nodes.map((n) => [Number(n.hetznerId), n]));

  const fleet = hetznerServers.map((s: any) => {
    const node = byHetznerId.get(Number(s.id));
    const serverType: string | null = s.server_type?.name ?? null;
    const monthlyEur = serverType ? SPEC_BY_TYPE[serverType]?.monthlyEur ?? null : null;
    return {
      hetznerId: s.id,
      name: s.name,
      serverType,
      monthlyEur,
      location: s.datacenter?.location?.name ?? s.datacenter?.name ?? null,
      datacenter: s.datacenter?.name ?? null,
      status: s.status,
      publicIp: s.public_net?.ipv4?.ip ?? null,
      privateIp: s.private_net?.[0]?.ip ?? null,
      createdAt: s.created,
      labels: s.labels ?? {},
      node: node
        ? {
            id: node.id,
            pool: node.pool,
            capacityCc: node.capacityCc,
            state: node.state,
            activeCalls: node.activeCalls,
            cpuPct: node.cpuPct,
            imageVersion: node.imageVersion,
            lastHeartbeatAt: node.lastHeartbeatAt,
            serviceType: node.serviceType,
            location: node.location,
          }
        : null,
    };
  });

  const orphanNodes = nodes
    .filter((n) => !hetznerServers.find((s: any) => Number(s.id) === Number(n.hetznerId)))
    .map((n) => ({ ...n, orphan: true }));

  return c.json({ data: fleet, orphanNodes, hetznerError });
});

/**
 * GET /platform/autoscaler/observation
 * What the planner would see on the next tick.
 */
router.get('/observation', async (c) => {
  try {
    const obs = await observer();
    return c.json(obs);
  } catch (err: any) {
    logger.error({ err }, '[autoscaler.routes] observation failed');
    return c.json({ error: err?.message ?? 'observer failed' }, 500);
  }
});

/**
 * GET /platform/autoscaler/decisions?kind=&ruleId=&limit=
 * Tail of the decisions log. Filters by kind and/or rule.
 */
const decisionsQuery = z.object({
  kind: z.string().optional(),
  ruleId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
router.get('/decisions', async (c) => {
  const q = decisionsQuery.parse(c.req.query());
  const filters = [
    q.kind ? eq(scalingDecisions.kind, q.kind) : undefined,
    q.ruleId ? eq(scalingDecisions.scalingRuleId, q.ruleId) : undefined,
  ].filter((f): f is NonNullable<typeof f> => f !== undefined);
  const rows = await db
    .select()
    .from(scalingDecisions)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(scalingDecisions.at))
    .limit(q.limit);
  return c.json({ data: rows });
});

/**
 * GET /platform/autoscaler/settings
 * All autoscaler-relevant platform_settings rows.
 */
router.get('/settings', async (c) => {
  const rows = await db.select().from(platformSettings);
  return c.json({ data: rows });
});

/**
 * PUT /platform/autoscaler/settings/:key
 * Update one setting. Validates flipping shadow mode off requires an explicit
 * confirm flag, since that's the gate between logging and real provisioning.
 */
const settingBody = z.object({
  value: z.string().min(1),
  confirmUnsafe: z.boolean().optional(),
});
router.put('/settings/:key', async (c) => {
  const key = c.req.param('key');
  const { value, confirmUnsafe } = settingBody.parse(await c.req.json());

  if (key === 'autoscaler_shadow_mode' && value === 'false' && !confirmUnsafe) {
    return c.json(
      {
        error: 'Turning shadow mode off enables real provisioning. Retry with confirmUnsafe=true.',
        code: 'SHADOW_MODE_GUARD',
      },
      400,
    );
  }

  const [existing] = await db
    .select()
    .from(platformSettings)
    .where(eq(platformSettings.key, key));

  if (existing) {
    await db
      .update(platformSettings)
      .set({ value, updatedAt: new Date() })
      .where(eq(platformSettings.key, key));
  } else {
    await db.insert(platformSettings).values({ key, value });
  }

  logger.info({ key, value, by: 'api' }, '[autoscaler.routes] setting updated');
  return c.json({ key, value });
});

/**
 * POST /platform/autoscaler/simulate
 * Creates synthetic media_nodes (hetzner_id >= 9_000_000_000) and active calls
 * so the observer/planner loop has something to react to during load testing.
 * Disabled in production (NODE_ENV=production) to prevent accidental data
 * pollution. Idempotent: repeated calls top up to the requested counts.
 *
 * Body:
 *   { nodeCount: 0..20, callCount: 0..10000, cleanup?: true }
 */
const simulateBody = z.object({
  nodeCount: z.number().int().min(0).max(20).default(0),
  callCount: z.number().int().min(0).max(10_000).default(0),
  cleanup: z.boolean().default(false),
});

router.post('/simulate', async (c) => {
  if (process.env.NODE_ENV === 'production') {
    return c.json({ error: 'simulate is disabled in production' }, 403);
  }
  const body = simulateBody.parse(await c.req.json());

  if (body.cleanup) {
    const delCallsRes = await db.execute<{ id: string }>(
      sql`DELETE FROM calls WHERE caller_id = ${SIM_CALLER_ID} RETURNING id`,
    );
    const delNodes = await db.delete(mediaNodes).where(gte(mediaNodes.hetznerId, SIM_HETZNER_BASE)).returning({ id: mediaNodes.id });
    const delCallCount = (delCallsRes as any).length ?? 0;
    logger.info({ calls: delCallCount, nodes: delNodes.length }, '[autoscaler.sim] cleaned');
    return c.json({ deletedCalls: delCallCount, deletedNodes: delNodes.length });
  }

  const [tenant] = await db.select().from(tenants).limit(1);
  if (!tenant) return c.json({ error: 'no tenant to attach synthetic calls to; seed first' }, 400);

  // Top up nodes: compute how many sim nodes already exist and add the delta.
  const existing = await db.select().from(mediaNodes).where(gte(mediaNodes.hetznerId, SIM_HETZNER_BASE));
  const want = body.nodeCount;
  const toAdd = Math.max(0, want - existing.length);
  const now = new Date();
  if (toAdd > 0) {
    const rows = Array.from({ length: toAdd }, (_, i) => ({
      hetznerId: SIM_HETZNER_BASE + existing.length + i,
      pool: 'elastic',
      serverType: 'cpx31',
      publicIp: `10.99.0.${(existing.length + i) % 255}`,
      capacityCc: 600,
      imageVersion: 'sim-v1',
      state: 'active',
      activeCalls: 0,
      lastHeartbeatAt: now,
    }));
    await db.insert(mediaNodes).values(rows);
  }
  // Refresh heartbeats on all sim nodes so they don't go stale during the test.
  await db.update(mediaNodes)
    .set({ lastHeartbeatAt: now, state: 'active' })
    .where(gte(mediaNodes.hetznerId, SIM_HETZNER_BASE));

  // Top up synthetic calls. Raw SQL here because the `calls` schema has drift
  // from the live DB (missing codec/sip_*/user_agent columns) and drizzle's
  // bulk insert includes all schema columns, causing 42703 errors.
  const existingCallsRes = await db.execute<{ count: number }>(
    sql`SELECT COUNT(*)::int AS count FROM calls WHERE caller_id = ${SIM_CALLER_ID}`,
  );
  const existingCallCount = Number((existingCallsRes as any)[0]?.count ?? 0);
  const wantCalls = body.callCount;
  const addCalls = Math.max(0, wantCalls - existingCallCount);
  if (addCalls > 0) {
    const valuesSql = Array.from({ length: addCalls }, (_, i) => {
      const callee = `+1555${String(existingCallCount + i).padStart(7, '0')}`;
      return sql`(${tenant.id}::uuid, 'outbound', ${SIM_CALLER_ID}, ${callee}, 'active')`;
    });
    await db.execute(sql`
      INSERT INTO calls (tenant_id, direction, caller_id, callee_number, status)
      VALUES ${sql.join(valuesSql, sql`, `)}
    `);
  }

  logger.info({ nodesAdded: toAdd, callsAdded: addCalls, want, wantCalls }, '[autoscaler.sim] primed');
  return c.json({
    nodes: { added: toAdd, total: Math.max(existing.length, want) },
    calls: { added: addCalls, total: Math.max(existingCallCount, wantCalls) },
  });
});

/**
 * GET /platform/autoscaler/catalog
 * Returns the server-type catalog and per-service capacity profiles.
 */
router.get('/catalog', (c) => {
  return c.json({ catalog: CATALOG, profiles: PROFILES });
});

/**
 * GET /platform/autoscaler/logs
 *   ?since=<unix_ms>  — only return entries newer than this (for tail polling)
 *   ?level=info|warn|error|debug  — minimum level
 *   ?limit=200       — max entries returned (most recent first cutoff)
 *   ?search=text     — substring filter on msg + data fields
 *
 * Reads from the in-memory ring buffer in lib/logger. Buffer is populated by
 * tapping pino via multistream, so this is the same stream that hits stdout —
 * not a journald scrape.
 */
const logsQuery = z.object({
  since: z.coerce.number().int().nonnegative().optional(),
  level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  search: z.string().min(1).max(200).optional(),
});
router.get('/logs', (c) => {
  const q = logsQuery.parse(c.req.query());
  const entries = getRecentLogs(q);
  return c.json({
    fetchedAt: Date.now(),
    entries: entries.map((e) => ({
      time: e.time,
      level: e.level,
      levelLabel: pinoLevelToLabel(e.level),
      msg: e.msg,
      data: e.data,
    })),
  });
});

function pinoLevelToLabel(level: number): string {
  if (level >= 60) return 'fatal';
  if (level >= 50) return 'error';
  if (level >= 40) return 'warn';
  if (level >= 30) return 'info';
  if (level >= 20) return 'debug';
  return 'trace';
}

/**
 * GET /platform/autoscaler/stock
 * Hetzner's per-DC availability matrix, normalised to slugs the rest of the
 * codebase uses (ccx23, cpx31, etc.). Cached for 5 minutes — availability
 * changes on the order of hours, but stale data here would mislead operators.
 *
 *   { fetchedAt, locations: [{ location, datacenter, available[], unavailable[] }] }
 */
interface StockSnapshot {
  fetchedAt: string;
  locations: Array<{ location: string; datacenter: string; available: string[]; unavailable: string[] }>;
}

let stockCache: { at: number; payload: StockSnapshot | { error: string } } | null = null;
const STOCK_TTL_MS = 5 * 60 * 1000;

router.get('/stock', async (c) => {
  if (stockCache && Date.now() - stockCache.at < STOCK_TTL_MS) {
    return c.json(stockCache.payload);
  }

  try {
    const [{ datacenters }, { server_types }] = await Promise.all([
      listDatacenters(),
      listServerTypes(),
    ]);

    // Filter to types we actually use (in the catalog) so the response is small.
    const knownIds = new Set(server_types.filter((t) => CATALOG.some((c) => c.type === t.name)).map((t) => t.id));
    const idToSlug = new Map(server_types.map((t) => [t.id, t.name] as const));

    const locations = datacenters.map((dc) => {
      const supported = (dc.server_types.supported ?? []).filter((id) => knownIds.has(id));
      const available = (dc.server_types.available ?? []).filter((id) => knownIds.has(id));
      const availableSet = new Set(available);
      const unavailable = supported.filter((id) => !availableSet.has(id));
      return {
        location: dc.location?.name ?? dc.name,
        datacenter: dc.name,
        available: available.map((id) => idToSlug.get(id)!).filter(Boolean).sort(),
        unavailable: unavailable.map((id) => idToSlug.get(id)!).filter(Boolean).sort(),
      };
    }).sort((a, b) => a.location.localeCompare(b.location));

    const payload: StockSnapshot = { fetchedAt: new Date().toISOString(), locations };
    stockCache = { at: Date.now(), payload };
    return c.json(payload);
  } catch (err: any) {
    const errPayload = { error: err?.message ?? 'Hetzner stock fetch failed' };
    // Cache errors briefly too — Hetzner outages shouldn't hammer the API.
    stockCache = { at: Date.now(), payload: errPayload };
    logger.warn({ err }, '[autoscaler.routes] stock fetch failed');
    return c.json(errPayload, 502);
  }
});

/**
 * POST /platform/autoscaler/recommend
 * Advisory: given a service + demand, return what to provision. Side-effect free.
 * Fleet can be passed explicitly for what-if analysis, or omitted to read the
 * current live fleet from media_nodes.
 *
 *   body: { service, demand, headroom?, maxCount?, minCount?,
 *           preferServerType?, ignoreExistingType?, fleet? }
 */
const recommendBody = z.object({
  service: z.string().min(1),
  demand: z.number().min(0),
  headroom: z.number().positive().optional(),
  maxCount: z.number().int().positive().optional(),
  minCount: z.number().int().min(0).optional(),
  preferServerType: z.string().optional(),
  ignoreExistingType: z.boolean().optional(),
  fleet: z.array(z.object({
    serverType: z.string(),
    capacityCc: z.number().int().min(0),
    state: z.string(),
  })).optional(),
});

router.post('/recommend', async (c) => {
  const body = recommendBody.parse(await c.req.json());

  // Resolve fleet: use body.fleet if provided; otherwise read live media_nodes
  // matching the requested service (v1: only freeswitch/media are actually populated).
  let fleet: FleetNode[] = body.fleet ?? [];
  if (!body.fleet) {
    const rows = await db.select().from(mediaNodes);
    fleet = rows.map((r) => ({
      serverType: r.serverType,
      capacityCc: r.capacityCc,
      state: r.state,
    }));
  }

  const rec = recommend(body.service, body.demand, fleet, {
    headroom: body.headroom,
    maxCount: body.maxCount,
    minCount: body.minCount,
    preferServerType: body.preferServerType,
    ignoreExistingType: body.ignoreExistingType,
  });
  return c.json(rec);
});

export default router;
