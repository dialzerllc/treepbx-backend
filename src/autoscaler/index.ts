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

import { observer, type Observation } from './observer';
import { planner, type Plan } from './planner';
import { reaper } from './reaper';
import { logDecision, isEnabled, isShadow, cooldownActive } from './state';
import { logger } from '../lib/logger';

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

  if (await cooldownActive()) {
    await logDecision({ kind: 'skip', reason: 'cooldown', shadow });
    return;
  }

  let obs: Observation;
  try {
    obs = await observer();
  } catch (err) {
    logger.error({ err }, '[autoscaler] observer failed');
    await logDecision({ kind: 'skip', reason: 'observer_error', shadow });
    return;
  }

  const plan: Plan = planner(obs);

  if (shadow) {
    await logDecision({
      kind: 'shadow',
      reason: plan.summary,
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
    targetCc: obs.targetCc,
    currentCc: obs.activeCc,
    carrierCeiling: obs.carrierCeiling,
    shadow: false,
  });
}
