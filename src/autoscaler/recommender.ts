/**
 * Pure-function recommender: given a service, a demand signal, and the current
 * fleet matching that service, return what to add (server type + count).
 *
 * Side-effect-free by design so the UI can call it to preview decisions without
 * touching production state. The tick-loop planner will eventually call this
 * same function to decide what to provision.
 *
 * Selection strategy, in order:
 *
 *   1. If current capacity already ≥ target (demand × headroom), return empty.
 *   2. If the fleet has nodes of a known preferred type, top up with the SAME
 *      type — homogeneity is easier to operate and predict.
 *   3. Otherwise walk preferred types smallest→largest. Pick the smallest type
 *      where count lands in the ops sweet spot [2..10]. This penalizes both
 *      "dozens of tiny nodes" and "one giant node with no HA".
 *   4. If no type hits the sweet spot, demand is either tiny or enormous:
 *        - tiny: return MIN_CLUSTER_SIZE of the smallest type (2-node HA floor)
 *        - enormous: return the biggest type at the count required
 */

import {
  PROFILES, SPEC_BY_TYPE,
  MIN_CLUSTER_SIZE, DEFAULT_HEADROOM, OPS_SWEET_SPOT_MIN, OPS_SWEET_SPOT_MAX,
  type ServiceProfile,
} from './catalog';

export interface FleetNode {
  serverType: string;           // 'ccx13', etc.
  capacityCc: number;           // this node's published capacity for its service
  state: string;                // 'active' | 'draining' | 'dead' | ...
}

export interface Recommendation {
  service: string;
  metricUnit: string;
  demand: number;
  headroom: number;
  target: number;               // demand × headroom
  currentCapacity: number;      // sum of healthy node capacities (matched to this service)
  shortfall: number;            // max(0, target - currentCapacity)
  actions: RecommendAction[];
  summary: string;
  costDeltaEurPerMonth: number; // approximate marginal cost of the recommendation
}

export type RecommendAction =
  | { op: 'add';    serverType: string; count: number; capacityEach: number; monthlyEur: number; reason: string }
  | { op: 'drain'; count: number; reason: string };

export interface RecommendOptions {
  headroom?: number;            // default 1.3
  maxCount?: number;            // planner will never recommend more than this per call
  minCount?: number;            // lower floor (below default MIN_CLUSTER_SIZE)
  preferServerType?: string;    // force the recommender to stick with a given type
  ignoreExistingType?: boolean; // skip the "top up with same type" heuristic
}

export function recommend(
  service: string,
  demand: number,
  fleet: FleetNode[] = [],
  options: RecommendOptions = {},
): Recommendation {
  const profile: ServiceProfile | undefined = PROFILES[service];

  if (!profile) {
    return {
      service, metricUnit: 'unknown', demand, headroom: 1, target: demand,
      currentCapacity: 0, shortfall: demand, actions: [],
      summary: `unknown service '${service}'`, costDeltaEurPerMonth: 0,
    };
  }

  const headroom = options.headroom ?? DEFAULT_HEADROOM;
  const target = Math.ceil(demand * headroom);

  const healthy = fleet.filter((n) => n.state === 'active');
  const currentCapacity = healthy.reduce((s, n) => s + (n.capacityCc || 0), 0);

  if (currentCapacity >= target) {
    const excess = currentCapacity - target;
    return {
      service, metricUnit: profile.metricUnit, demand, headroom, target,
      currentCapacity, shortfall: 0, actions: [],
      summary: `no action: ${currentCapacity} cap ≥ ${target} target (excess ${excess})`,
      costDeltaEurPerMonth: 0,
    };
  }

  const shortfall = target - currentCapacity;

  // Candidate type picker
  const pick = selectServerType(profile, shortfall, healthy, options);
  const count = clamp(pick.count, options.minCount ?? MIN_CLUSTER_SIZE, options.maxCount ?? 50);
  const spec = SPEC_BY_TYPE[pick.type];
  const capEach = profile.capacityFor[pick.type];
  const monthlyEur = spec ? spec.monthlyEur * count : 0;

  return {
    service, metricUnit: profile.metricUnit, demand, headroom, target,
    currentCapacity, shortfall,
    actions: [
      {
        op: 'add',
        serverType: pick.type,
        count,
        capacityEach: capEach,
        monthlyEur,
        reason: pick.reason,
      },
    ],
    summary: `add ${count}× ${pick.type} (capacity ${capEach} each) to cover shortfall of ${shortfall}`,
    costDeltaEurPerMonth: monthlyEur,
  };
}

// ── Server-type selection heuristics ──────────────────────────────────────

interface Pick {
  type: string;
  count: number;
  reason: string;
}

function selectServerType(
  profile: ServiceProfile,
  shortfall: number,
  healthy: FleetNode[],
  options: RecommendOptions,
): Pick {
  // Forced override
  if (options.preferServerType) {
    const cap = profile.capacityFor[options.preferServerType];
    if (cap) {
      return {
        type: options.preferServerType,
        count: Math.ceil(shortfall / cap),
        reason: `forced by preferServerType=${options.preferServerType}`,
      };
    }
  }

  // Homogeneity: top up with a type already in the fleet — but only if the
  // additions fit the ops sweet spot. If topping up the same type would push
  // new-node count past the sweet spot ceiling, fall through to the fresh pick;
  // scaling by switching to a larger type is better than running 20 tiny ones.
  if (!options.ignoreExistingType && healthy.length > 0) {
    const typeCounts = new Map<string, number>();
    for (const n of healthy) typeCounts.set(n.serverType, (typeCounts.get(n.serverType) ?? 0) + 1);
    const existingPreferred = profile.preferred.filter((t) => typeCounts.has(t));
    if (existingPreferred.length > 0) {
      const t = existingPreferred[existingPreferred.length - 1];
      const cap = profile.capacityFor[t];
      const topUpCount = Math.ceil(shortfall / cap);
      if (topUpCount <= OPS_SWEET_SPOT_MAX) {
        return {
          type: t,
          count: topUpCount,
          reason: `matches existing fleet (${typeCounts.get(t)} already running)`,
        };
      }
      // else: topping up would bloat the cluster; fall through to type-upgrade path
    }
  }

  // Fresh pick: walk preferred list smallest→largest, return first sweet-spot fit
  for (const t of profile.preferred) {
    const cap = profile.capacityFor[t];
    const count = Math.ceil(shortfall / cap);
    if (count >= OPS_SWEET_SPOT_MIN && count <= OPS_SWEET_SPOT_MAX) {
      return { type: t, count, reason: `smallest type hitting sweet spot (count=${count})` };
    }
  }

  // Tiny or huge fallback
  const smallest = profile.preferred[0];
  const biggest = profile.preferred[profile.preferred.length - 1];

  const countAtSmallest = Math.ceil(shortfall / profile.capacityFor[smallest]);
  if (countAtSmallest < OPS_SWEET_SPOT_MIN) {
    return {
      type: smallest,
      count: MIN_CLUSTER_SIZE,
      reason: `demand tiny — 2-node HA floor at smallest type`,
    };
  }

  // Demand larger than biggest×sweet_spot_max — this is an extreme case; surface it but still plan
  return {
    type: biggest,
    count: Math.ceil(shortfall / profile.capacityFor[biggest]),
    reason: `demand exceeds sweet spot at every type; biggest type chosen`,
  };
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}
