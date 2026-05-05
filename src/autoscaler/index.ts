/**
 * Multi-service autoscaler.
 *
 * One 30-second tick:
 *   1. Reaper — flips stale rows to dead, destroys their Hetzner servers.
 *   2. Observer — collects per-service load + node counts.
 *   3. For each service scope (freeswitch, sip_proxy): planner → executor.
 *
 * Shadow-mode is the default and must be turned off explicitly. That means
 * a fresh deploy never provisions on its own — ops review the decisions log
 * first, then flip `autoscaler_shadow_mode` to 'false' once they're comfortable.
 */

import { asc, eq } from 'drizzle-orm';
import { observer, type Observation, type ServiceObservation } from './observer';
import { planner, type Plan, type PlannerRule } from './planner';
import { reaper } from './reaper';
import { executeProvision, executeDrain } from './executor';
import {
  logDecision, isEnabled, isShadow,
  cooldownActive, ruleCooldownActive,
} from './state';
import { db } from '../db/client';
import { scalingRules } from '../db/schema';
import { logger } from '../lib/logger';

const SCOPES = ['freeswitch', 'sip_proxy'] as const;

async function loadActiveRules(): Promise<PlannerRule[]> {
  const rows = await db.select().from(scalingRules)
    .where(eq(scalingRules.enabled, true))
    .orderBy(asc(scalingRules.priority));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    serviceType: r.serviceType,
    enabled: r.enabled ?? true,
    priority: r.priority,
    minInstances: r.minInstances,
    maxInstances: r.maxInstances,
    callsPerInstance: r.callsPerInstance,
    cooldownSeconds: r.cooldownSeconds,
    warmSpare: r.warmSpare,
  }));
}

async function runScope(serviceObs: ServiceObservation, rules: PlannerRule[], shadow: boolean) {
  const plan: Plan = planner(serviceObs, rules);

  const cooldown = plan.matchedRule
    ? await ruleCooldownActive(plan.matchedRule.id, plan.matchedRule.cooldownSeconds)
    : await cooldownActive();

  if (cooldown) {
    const tag = plan.matchedRule ? `rule ${plan.matchedRule.name}` : 'default';
    await logDecision({
      kind: 'skip',
      reason: `[${serviceObs.serviceType}] cooldown (${tag})`,
      scalingRuleId: plan.matchedRule?.id ?? null,
      shadow,
    });
    return;
  }

  if (shadow) {
    await logDecision({
      kind: 'shadow',
      reason: plan.summary,
      scalingRuleId: plan.matchedRule?.id ?? null,
      targetCc: serviceObs.targetCc,
      currentCc: serviceObs.load,
      carrierCeiling: serviceObs.carrierCeiling,
      shadow: true,
    });
    logger.info({ plan, obs: serviceObs }, '[autoscaler] shadow decision');
    return;
  }

  if (plan.provision === 0 && plan.drainNodeIds.length === 0) {
    await logDecision({
      kind: 'skip',
      reason: `no-op: ${plan.summary}`,
      scalingRuleId: plan.matchedRule?.id ?? null,
      shadow: false,
    });
    return;
  }

  if (plan.provision > 0) {
    try {
      const created = await executeProvision({
        count: plan.provision,
        serviceType: serviceObs.serviceType,
      });
      for (const c of created) {
        await logDecision({
          kind: 'provision',
          nodeId: c.nodeId,
          reason: `executor: created ${c.name} (${c.publicIp})`,
          scalingRuleId: plan.matchedRule?.id ?? null,
          targetCc: serviceObs.targetCc,
          currentCc: serviceObs.load,
          carrierCeiling: serviceObs.carrierCeiling,
          shadow: false,
        });
      }
      logger.info({ created: created.length, plan }, '[autoscaler] provision executed');
    } catch (err: any) {
      logger.error({ err: err?.message ?? String(err), serviceType: serviceObs.serviceType }, '[autoscaler] provision failed');
      await logDecision({
        kind: 'skip',
        reason: `[${serviceObs.serviceType}] executor_error: ${err?.message ?? String(err)}`.slice(0, 240),
        scalingRuleId: plan.matchedRule?.id ?? null,
        shadow: false,
      });
    }
  }

  if (plan.drainNodeIds.length > 0) {
    const n = await executeDrain(plan.drainNodeIds);
    await logDecision({
      kind: 'drain',
      reason: `[${serviceObs.serviceType}] executor: drained ${n} nodes`,
      scalingRuleId: plan.matchedRule?.id ?? null,
      shadow: false,
    });
  }
}

export async function runAutoscalerTick(): Promise<void> {
  if (!(await isEnabled())) return;

  const shadow = await isShadow();

  // Reap first so the observer sees post-reap counts. Reaper handles its own
  // Hetzner deletes; in shadow mode it skips the destroy step.
  try {
    const n = await reaper(shadow);
    if (n > 0) logger.info({ reaped: n }, '[autoscaler] reaper marked nodes dead');
  } catch (err) {
    logger.error({ err }, '[autoscaler] reaper failed');
  }

  let obs: Observation;
  try {
    obs = await observer();
  } catch (err) {
    logger.error({ err }, '[autoscaler] observer failed');
    await logDecision({ kind: 'skip', reason: 'observer_error', shadow });
    return;
  }

  const rules = await loadActiveRules();

  for (const scope of SCOPES) {
    try {
      await runScope(obs[scope], rules, shadow);
    } catch (err) {
      logger.error({ err, scope }, '[autoscaler] scope tick failed');
    }
  }
}
