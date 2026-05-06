import { Hono } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { mediaNodes, amdDecisions, calls, campaigns } from '../db/schema';
import { BadRequest, Unauthorized, NotFound } from '../lib/errors';
import { logger } from '../lib/logger';
import { spawn } from 'child_process';
import { getFileBuffer, uploadFile } from '../integrations/minio';
import { transcribeBuffer, evalProbe, DEFAULT_AI_SCREEN_EVAL_PROMPT } from '../integrations/gpu';

const router = new Hono();

/**
 * Shared token for bootstrap calls from media nodes.
 * Set BOOTSTRAP_TOKEN in the backend .env and bake the same token into the
 * media-node Packer image (or inject via cloud-init).
 *
 * Why a shared token rather than per-node keys?
 *  - Node identity is established by the Hetzner API (we own both ends).
 *  - Per-node keys complicate the Packer image bake. The real authz is that
 *    the Hetzner ID + public IP must match what the autoscaler just provisioned.
 */
router.use('*', async (c, next) => {
  const token = c.req.header('Authorization')?.replace(/^Bearer\s+/, '');
  const expected = process.env.BOOTSTRAP_TOKEN;
  if (!expected || !token || token !== expected) {
    throw new Unauthorized('Invalid bootstrap token');
  }
  await next();
});

const registerSchema = z.object({
  hetznerId: z.number().int(),
  pool: z.enum(['baseline', 'hot_spare', 'elastic']),
  serverType: z.string(),
  publicIp: z.string(),
  privateIp: z.string().optional(),
  capacityCc: z.number().int().min(1),
  imageVersion: z.string(),
});

/**
 * Detached config-bootstrap for a freshly-registered fleet node.
 *
 * Different roles need different config (FS external profile + dialplan, sip
 * proxy kamailio.cfg + dispatcher list, etc). The actual logic lives in
 * scripts/fleet-config/<role>-bootstrap.sh — this just spawns it without
 * blocking the /register response.
 *
 * Retries on non-zero exit: SSH on a freshly-booted node is racy (sshd takes
 * a few seconds to be ready, the docker daemon another few). We back off and
 * retry up to 3 times so a transient race doesn't leave a node un-configured.
 *
 * If the script doesn't exist for a role we just skip silently — operators
 * can SSH in and configure the box manually for now.
 */
export function spawnBootstrap(serviceType: string, publicIp: string, attempt = 1): void {
  const dir = process.env.FLEET_CONFIG_DIR ?? '/opt/tpbx/backend/scripts/fleet-config';
  const map: Record<string, { script: string; args: string[] }> = {
    freeswitch: { script: `${dir}/freeswitch-bootstrap.sh`, args: [publicIp] },
    // sip_proxy: floating IP equals public_ip in this fleet (we set media_nodes.public_ip
    // to the FIP at registration), so pass it twice — script wants <sip-ip> <floating-ip>.
    sip_proxy:  { script: `${dir}/kamailio-bootstrap.sh`,   args: [publicIp, publicIp] },
  };
  const entry = map[serviceType];
  if (!entry) return;

  const MAX_ATTEMPTS = 3;
  const BACKOFF_MS = [0, 30_000, 90_000];   // [retry-1, retry-2, retry-3]

  try {
    const child = spawn(entry.script, entry.args, {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    child.stdout?.on('data', (d) => logger.info({ ip: publicIp, role: serviceType, attempt, out: d.toString().trim() }, '[bootstrap] stdout'));
    child.stderr?.on('data', (d) => logger.warn({ ip: publicIp, role: serviceType, attempt, err: d.toString().trim() }, '[bootstrap] stderr'));
    child.on('exit', (code) => {
      if (code === 0) {
        logger.info({ ip: publicIp, role: serviceType, attempt }, '[bootstrap] success');
        return;
      }
      logger.warn({ ip: publicIp, role: serviceType, attempt, exitCode: code }, '[bootstrap] failed');
      if (attempt < MAX_ATTEMPTS) {
        const wait = BACKOFF_MS[attempt] ?? 60_000;
        logger.info({ ip: publicIp, role: serviceType, retryIn: wait }, '[bootstrap] scheduling retry');
        setTimeout(() => spawnBootstrap(serviceType, publicIp, attempt + 1), wait);
      } else {
        logger.error({ ip: publicIp, role: serviceType }, '[bootstrap] giving up after max attempts');
      }
    });
    child.unref();
  } catch (err: any) {
    logger.warn({ err: err?.message ?? String(err), serviceType, publicIp, attempt }, '[bootstrap] spawn threw');
    if (attempt < MAX_ATTEMPTS) {
      setTimeout(() => spawnBootstrap(serviceType, publicIp, attempt + 1), BACKOFF_MS[attempt] ?? 60_000);
    }
  }
}

/**
 * Media node calls this on first boot, after cloud-init finishes.
 * Idempotent — if the node already exists (e.g. process restart), update
 * its public IP and move back to 'active'.
 *
 * On *first* registration of a freeswitch (or other configurable role) node,
 * fires the role bootstrap script in the background to apply our canonical
 * config (auth, ACL, dialplan). Re-registrations skip the bootstrap to avoid
 * spamming a live box that's just had its agent restart.
 */
router.post('/media-nodes/register', async (c) => {
  const body = registerSchema.parse(await c.req.json());
  const [existing] = await db.select().from(mediaNodes).where(eq(mediaNodes.hetznerId, body.hetznerId));

  if (existing) {
    const [row] = await db.update(mediaNodes).set({
      publicIp: body.publicIp,
      privateIp: body.privateIp ?? existing.privateIp,
      state: 'active',
      lastHeartbeatAt: new Date(),
    }).where(eq(mediaNodes.id, existing.id)).returning();
    logger.info({ nodeId: row.id, hetznerId: body.hetznerId, prevState: existing.state }, '[media-nodes] re-registered');

    // First-time boot of an autoscaler-pre-inserted row: row was created in
    // 'provisioning' state by executor.ts, the agent now reports 'active' for
    // the first time. Apply role config exactly once on this transition.
    if (existing.state === 'provisioning') {
      spawnBootstrap(row.serviceType, body.publicIp);
    }

    return c.json({ nodeId: row.id, assigned: { bootstrapToken: '***' } });
  }

  const [row] = await db.insert(mediaNodes).values({
    hetznerId: body.hetznerId,
    pool: body.pool,
    serverType: body.serverType,
    publicIp: body.publicIp,
    privateIp: body.privateIp ?? null,
    capacityCc: body.capacityCc,
    imageVersion: body.imageVersion,
    state: 'active',
    lastHeartbeatAt: new Date(),
  }).returning();
  logger.info({ nodeId: row.id, hetznerId: body.hetznerId, pool: body.pool }, '[media-nodes] registered');

  // Fire-and-forget role bootstrap (only on first register, since 'existing' was null).
  // We don't know serviceType from the body — read it back from the row we just wrote.
  spawnBootstrap(row.serviceType, body.publicIp);

  return c.json({ nodeId: row.id }, 201);
});

const heartbeatSchema = z.object({
  activeCalls: z.number().int().min(0),
  cpuPct: z.number().min(0).max(100).optional(),
});

/**
 * Media node calls this every ~10s with live stats. If we haven't heard from a
 * node in >60s the autoscaler treats it as dead and schedules a replacement.
 *
 * If the node was previously reaped to 'dead' but is now heartbeating again,
 * lift it back to 'active'. Don't touch nodes mid-drain or mid-terminate —
 * those transitions are owned by the autoscaler executor.
 */
router.put('/media-nodes/:id/heartbeat', async (c) => {
  const body = heartbeatSchema.parse(await c.req.json());
  const [current] = await db.select({ state: mediaNodes.state }).from(mediaNodes).where(eq(mediaNodes.id, c.req.param('id')));
  if (!current) throw new NotFound('media node not registered');
  const reviveToActive = current.state === 'dead' || current.state === 'provisioning' || current.state === 'registering';
  const [row] = await db.update(mediaNodes).set({
    activeCalls: body.activeCalls,
    cpuPct: body.cpuPct ?? null,
    lastHeartbeatAt: new Date(),
    ...(reviveToActive ? { state: 'active' } : {}),
  }).where(eq(mediaNodes.id, c.req.param('id'))).returning();
  return c.json({ ok: true, state: row.state });
});

/**
 * Autoscaler calls this when it wants a node to stop accepting new calls.
 * The node's agent polls its own row's state — when it flips to 'draining'
 * it refuses new INVITEs. Actual server termination happens only once
 * active_calls drops to 0 (or the hard 10-min cap).
 */
router.post('/media-nodes/:id/drain', async (c) => {
  const [row] = await db.update(mediaNodes).set({
    state: 'draining',
    drainStartedAt: new Date(),
  }).where(eq(mediaNodes.id, c.req.param('id'))).returning();
  if (!row) throw new NotFound('media node not registered');
  logger.info({ nodeId: row.id }, '[media-nodes] drain requested');
  return c.json({ ok: true });
});

/**
 * Node reads this on boot to fetch config (SIP creds, BYOC carriers, rate limits).
 * Keeps sensitive config out of the Packer image.
 */
/**
 * POST /internal/ai-probe
 * Called by ai-screen.lua mid-call. Multipart fields:
 *   file        — captured response audio (~4s WAV).
 *   call_id     — treepbx call.id (UUID).
 *   probe_text  — the prompt the bot played.
 *   eval_prompt — optional override of the LLM system prompt.
 *
 * Flow: receive file → upload to R2 (audit/<tenantId>/<callId>-probe.wav)
 *       → STT → LLM verdict → write amd_decisions row → return
 *       {decision, is_human, transcript, reason, latency_ms}.
 *
 * Errors map into is_human=true (fail-open). A live call should never be
 * dropped because of a transient GPU/R2 blip — the worst case is bridging
 * to an agent who hangs up; the best case (with our infra healthy) is
 * filtering the recording.
 */
router.post('/ai-probe', async (c) => {
  const t0 = Date.now();
  // Body is raw audio bytes (audio/wav). Metadata is in URL query params:
  // call_id, probe_text, eval_prompt. Lua uses busybox wget which supports
  // --post-file but not multipart, so this is the simplest contract.
  const callId = c.req.query('call_id') ?? '';
  const probeText = c.req.query('probe_text') ?? '';
  const evalPrompt = c.req.query('eval_prompt') ?? '';

  if (!callId || !probeText) {
    throw new BadRequest('missing call_id or probe_text');
  }
  if (!/^[0-9a-f-]{36}$/i.test(callId)) {
    throw new BadRequest('invalid call_id');
  }
  const audioBuf = Buffer.from(await c.req.arrayBuffer());
  if (audioBuf.length === 0) {
    throw new BadRequest('empty audio body');
  }

  const [call] = await db.select({
    id: calls.id,
    tenantId: calls.tenantId,
    campaignId: calls.campaignId,
  }).from(calls).where(eq(calls.id, callId));

  if (!call) {
    throw new NotFound('call not found for ai-probe');
  }

  let isHuman = true;
  let reason = '';
  let transcriptText = '';
  let llmRaw = '';
  let audioKey: string | null = null;

  try {
    audioKey = `audit/${call.tenantId}/${callId}-probe.wav`;
    // Upload audio to R2 in parallel with STT — STT doesn't depend on R2.
    const [, sttResult] = await Promise.all([
      uploadFile(audioKey, audioBuf, 'audio/wav').catch((e) => {
        logger.warn({ err: e?.message ?? String(e), audioKey }, '[ai-probe] R2 upload failed (audit row will lack audio key)');
        audioKey = null;
        return null;
      }),
      transcribeBuffer(audioBuf),
    ]);
    transcriptText = sttResult.text;

    const verdict = await evalProbe({
      systemPrompt: evalPrompt || DEFAULT_AI_SCREEN_EVAL_PROMPT,
      probeText,
      responseTranscript: transcriptText,
    });
    isHuman = verdict.isHuman;
    reason = verdict.reason;
    llmRaw = verdict.raw;
  } catch (err: any) {
    reason = `error: ${err?.message ?? String(err)}`.slice(0, 240);
    logger.error({ err: err?.message ?? String(err), callId }, '[ai-probe] failed — defaulting to is_human=true');
  }

  const totalMs = Date.now() - t0;

  await db.insert(amdDecisions).values({
    callId: call.id,
    campaignId: call.campaignId ?? null,
    tenantId: call.tenantId ?? null,
    source: 'ai_screen',
    amdResult: isHuman ? 'human' : 'machine',
    action: isHuman ? 'bridge' : 'hangup',
    audioKey,
    probeText,
    transcript: transcriptText,
    reason: reason.slice(0, 240),
    llmRaw: llmRaw.slice(0, 4000),
    decidedAtMs: totalMs,
    totalLatencyMs: totalMs,
  }).catch((e) => {
    logger.warn({ err: e?.message ?? String(e), callId }, '[ai-probe] audit insert failed (non-fatal)');
  });

  return c.json({
    decision: isHuman ? 'bridge' : 'hangup',
    is_human: isHuman,
    transcript: transcriptText,
    reason,
    latency_ms: totalMs,
  });
});

router.get('/media-config', async (c) => {
  return c.json({
    // TODO: surface per-tenant BYOC carriers, rate cards, dispatcher endpoint, etc.
    // For bootstrap this can stay empty — nodes still register and heartbeat.
    version: 1,
    controlPlaneHeartbeatUrl: '/api/v1/internal/media-nodes/HEARTBEAT_SELF',
  });
});

export default router;
