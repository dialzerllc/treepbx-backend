/**
 * Autoscaler planner — pure function from observation to action.
 *
 * No DB access, no side effects, fully unit-testable. The executor turns a Plan
 * into Hetzner API calls; in shadow mode we just log.
 */

import type { Observation } from './observer';

export interface Plan {
  desiredNodes: number;    // total active nodes including the +1 warm spare
  provision: number;        // how many to add
  drainNodeIds: string[];   // node ids to drain (not used in v1 — planner just returns targets)
  summary: string;          // human-readable summary for the decisions log
}

export function planner(obs: Observation): Plan {
  // Minimum floor: always keep 1 baseline node. Planner never scales to zero.
  const floor = 1;

  // Desired active capacity to handle targetCc, then +1 warm spare so a sudden
  // burst has ~60s of buffer while a new node provisions.
  const neededForLoad = Math.max(floor, Math.ceil(obs.targetCc / obs.perNodeCapacity));
  const desiredNodes = neededForLoad + 1;

  // Existing capacity — subtract stale nodes because they can't actually serve.
  const healthy = Math.max(0, obs.nodes.active - obs.nodes.stale);

  const provision = Math.max(0, desiredNodes - healthy);

  return {
    desiredNodes,
    provision,
    drainNodeIds: [],       // v1: no scale-down logic yet; conservative by design
    summary: `target=${obs.targetCc}cc, healthy=${healthy}, desired=${desiredNodes}, provision=+${provision}`,
  };
}
