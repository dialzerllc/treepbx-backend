/**
 * Media-fleet autoscaler.
 *
 * A single 30-second loop that:
 *   1. Observes current load + carrier capacity + fleet health
 *   2. Plans how many nodes it wants (headroom + warm-spare invariant)
 *   3. Executes (or, in shadow mode, logs the plan for operator review)
 *
 * Shadow-mode is the default and must be turned off explicitly. That means
 * a fresh deploy never provisions anything on its own — ops review the
 * decisions log first, then flip `autoscaler_shadow_mode` to 'false' once
 * they're comfortable.
 */

import { asc, eq } from 'drizzle-orm';
import { observer, type Observation } from './observer';
import { planner, type Plan, type PlannerRule } from './planner';
import { reaper } from './reaper';
import {
  logDecision, isEnabled, isShadow,
  cooldownActive, ruleCooldownActive,
} from './state';
import { db } from '../db/client';
import { scalingRules } from '../db/schema';
import { logger } from '../lib/logger';

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
  }));
}

export async function runAutoscalerTick(): Promise<void> {
  if (!(await isEnabled())) return;

  const shadow = await isShadow();

  // Reap first so the observer sees post-reap counts. Reaping only flips DB
  // state — it never calls Hetzner — so it runs regardless of shadow mode.
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
  const plan: Plan = planner(obs, rules);

  // Cooldown — per-rule when a rule matched, otherwise the global default.
  const cooldown = plan.matchedRule
    ? await ruleCooldownActive(plan.matchedRule.id, plan.matchedRule.cooldownSeconds)
    : await cooldownActive();

  if (cooldown) {
    const tag = plan.matchedRule ? `rule ${plan.matchedRule.name}` : 'default';
    await logDecision({
      kind: 'skip',
      reason: `cooldown (${tag})`,
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
      targetCc: obs.targetCc,
      currentCc: obs.activeCc,
      carrierCeiling: obs.carrierCeiling,
      shadow: true,
    });
    logger.info({ plan, obs }, '[autoscaler] shadow decision');
    return;
  }

  // Real execution path. Stubbed for now — we don't wire the Hetzner API call
  // into this session until we've reviewed shadow-mode decisions.
  // TODO(autoscaler): add executor.ts that calls Hetzner hcloud API + updates DB.
  logger.warn({ plan }, '[autoscaler] executor not wired yet — decision dropped');
  await logDecision({
    kind: 'skip',
    reason: 'executor_not_wired',
    scalingRuleId: plan.matchedRule?.id ?? null,
    targetCc: obs.targetCc,
    currentCc: obs.activeCc,
    carrierCeiling: obs.carrierCeiling,
    shadow: false,
  });
}
