/**
 * Autoscaler planner — pure function from observation + rules to action.
 *
 * No DB access, no side effects, fully unit-testable. The executor turns a Plan
 * into Hetzner API calls; in shadow mode we just log.
 *
 * Rule matching: first enabled rule whose `serviceType` matches the autoscaler's
 * scope (currently only 'freeswitch' since this is the media-node autoscaler),
 * ordered by `priority` ascending. If no rule matches, falls back to a 1-node
 * floor with the global per-node capacity from the observation.
 */
import type { Observation } from './observer';

// Subset of fields the planner needs from a scaling_rules row. Keeping this
// narrow lets the planner stay pure — the caller projects from the DB row.
export interface PlannerRule {
  id: string;
  name: string;
  serviceType: string;
  enabled: boolean;
  priority: number;
  minInstances: number | null;
  maxInstances: number | null;
  callsPerInstance: number | null;
  cooldownSeconds: number | null;
}

export interface MatchedRule {
  id: string;
  name: string;
  cooldownSeconds: number;
}

export interface Plan {
  desiredNodes: number;        // total active nodes including the +1 warm spare
  provision: number;            // how many to add
  drainNodeIds: string[];       // node ids to drain (not used in v1)
  matchedRule: MatchedRule | null;  // null when no rule matched (default fallback)
  summary: string;              // human-readable summary for the decisions log
}

const SERVICE_SCOPE = 'freeswitch';     // this autoscaler's responsibility
const DEFAULT_FLOOR = 1;
const DEFAULT_COOLDOWN = 300;

export function planner(obs: Observation, rules: PlannerRule[] = []): Plan {
  // Caller is expected to pass enabled rules ordered by priority asc, but we
  // re-filter defensively so the planner is correct regardless of input order.
  const matched = rules
    .filter((r) => r.enabled && r.serviceType === SERVICE_SCOPE)
    .sort((a, b) => a.priority - b.priority)[0] ?? null;

  const min = matched?.minInstances ?? DEFAULT_FLOOR;
  const max = matched?.maxInstances ?? Number.POSITIVE_INFINITY;
  const perNode = matched?.callsPerInstance && matched.callsPerInstance > 0
    ? matched.callsPerInstance
    : obs.perNodeCapacity;
  const cooldown = matched?.cooldownSeconds ?? DEFAULT_COOLDOWN;

  // Desired active capacity to handle targetCc, then +1 warm spare so a sudden
  // burst has ~60s of buffer while a new node provisions. Bounded by the rule.
  const neededForLoad = Math.max(min, Math.ceil(obs.targetCc / perNode));
  const desiredNodes = Math.min(max, neededForLoad + 1);

  // Existing capacity — subtract stale nodes because they can't actually serve.
  const healthy = Math.max(0, obs.nodes.active - obs.nodes.stale);

  const provision = Math.max(0, desiredNodes - healthy);

  const ruleTag = matched ? `rule=${matched.name}` : 'rule=<default>';
  return {
    desiredNodes,
    provision,
    drainNodeIds: [],
    matchedRule: matched ? { id: matched.id, name: matched.name, cooldownSeconds: cooldown } : null,
    summary: `${ruleTag} target=${obs.targetCc}cc, healthy=${healthy}, desired=${desiredNodes}, provision=+${provision}`,
  };
}
