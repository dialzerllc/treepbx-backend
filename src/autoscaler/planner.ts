/**
 * Autoscaler planner — pure function from per-service observation + rules to action.
 *
 * No DB access, no side effects, fully unit-testable. The executor turns a Plan
 * into Hetzner API calls; in shadow mode we just log.
 *
 * Rule matching: first enabled rule whose `serviceType` matches the planner's
 * scope, ordered by `priority` ascending. If no rule matches, falls back to a
 * 1-node floor with the per-node capacity from the observation.
 */
import type { ServiceObservation } from './observer';

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
  serviceType: string;
  desiredNodes: number;        // total active nodes including the +1 warm spare
  provision: number;            // how many to add
  drainNodeIds: string[];       // node ids to drain (not used in v1)
  matchedRule: MatchedRule | null;
  summary: string;
}

const DEFAULT_FLOOR = 1;
const DEFAULT_COOLDOWN = 300;

export function planner(obs: ServiceObservation, rules: PlannerRule[] = []): Plan {
  const matched = rules
    .filter((r) => r.enabled && r.serviceType === obs.serviceType)
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
    serviceType: obs.serviceType,
    desiredNodes,
    provision,
    drainNodeIds: [],
    matchedRule: matched ? { id: matched.id, name: matched.name, cooldownSeconds: cooldown } : null,
    summary: `[${obs.serviceType}] ${ruleTag} target=${obs.targetCc}, healthy=${healthy}, desired=${desiredNodes}, provision=+${provision}`,
  };
}
