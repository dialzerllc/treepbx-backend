import { db } from '../db/client';
import { carriers, calls, users } from '../db/schema';
import { eq, and, inArray, isNull, lt, sql } from 'drizzle-orm';
import { logger } from '../lib/logger';
import { execSync } from 'child_process';
import { publishAgentStatus } from '../ws/publisher';

/**
 * Checks reachability of all active carriers by pinging their SIP port.
 * Runs periodically (every 60 seconds).
 * Also reaps stale calls and unsticks agents.
 */
export function startCarrierHealthCheck() {
  // Initial check after 10 seconds
  setTimeout(runCheck, 10_000);
  // Then every 60 seconds
  setInterval(runCheck, 60_000);

  // Stale call reaper every 2 minutes
  setTimeout(reapStaleCalls, 30_000);
  setInterval(reapStaleCalls, 120_000);

  logger.info('[HealthCheck] Carrier health check started (60s interval)');
  logger.info('[HealthCheck] Stale call reaper started (120s interval)');
}

async function runCheck() {
  try {
    const allCarriers = await db.select({
      id: carriers.id,
      name: carriers.name,
      host: carriers.host,
      port: carriers.port,
      status: carriers.status,
    }).from(carriers);

    for (const c of allCarriers) {
      if (c.status !== 'active') continue;
      const reachable = await checkHost(c.host, c.port ?? 5060);
      await db.update(carriers)
        .set({ reachable, lastChecked: new Date() })
        .where(eq(carriers.id, c.id));
    }
  } catch (err: any) {
    logger.error({ err: err.message }, '[HealthCheck] Failed');
  }
}

async function checkHost(host: string, port: number): Promise<boolean> {
  try {
    execSync(`nc -zu -w 2 ${host} ${port}`, { timeout: 5000, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Reaps calls stuck in ringing/answered with no hangup event.
 * Also releases agents stuck in on_call/wrap_up with no active calls.
 */
async function reapStaleCalls() {
  try {
    const staleThreshold = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 minutes

    // 1. Close orphaned calls (ringing/answered for > 10 min with no end)
    const staleCalls = await db.update(calls).set({
      status: 'completed',
      endedAt: new Date(),
      hangupCause: 'RECOVERY_ON_TIMER_EXPIRE',
    }).where(and(
      inArray(calls.status, ['ringing', 'answered']),
      isNull(calls.endedAt),
      lt(calls.startedAt, staleThreshold),
    )).returning({ id: calls.id, agentId: calls.agentId, tenantId: calls.tenantId });

    if (staleCalls.length > 0) {
      logger.warn({ count: staleCalls.length, ids: staleCalls.map((c) => c.id) }, '[Reaper] Closed stale calls');
    }

    // 2. Release agents stuck in on_call with no active calls
    const stuckAgents = await db.execute(sql`
      UPDATE users SET status = 'available', status_changed_at = NOW()
      WHERE status IN ('on_call', 'wrap_up')
      AND status_changed_at < ${staleThreshold}
      AND id NOT IN (
        SELECT agent_id FROM calls
        WHERE status IN ('ringing', 'answered')
        AND agent_id IS NOT NULL
      )
      RETURNING id, tenant_id, email
    `);

    const released = (stuckAgents as any) as { id: string; tenant_id: string; email: string }[];
    if (released.length > 0) {
      logger.warn({ count: released.length, agents: released.map((a) => a.email) }, '[Reaper] Released stuck agents');
      for (const agent of released) {
        publishAgentStatus(agent.tenant_id, agent.id, 'available');
      }
    }
  } catch (err: any) {
    logger.error({ err: err.message }, '[Reaper] Failed');
  }
}
