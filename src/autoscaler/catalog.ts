/**
 * Server catalog and per-service capacity profiles.
 *
 * The catalog is a static snapshot of Hetzner Cloud server types. Pricing is
 * approximate (EUR/month, US locations slightly higher) — it's used as a
 * tiebreaker, not an SLO. Update when Hetzner's catalog changes.
 *
 * Per-service capacity figures are conservative single-node throughput targets
 * sized for ~70% steady-state utilization, so a tick of scale-up headroom
 * absorbs bursts without paging. They should be replaced with measured values
 * once the fleet produces production telemetry.
 */

export interface ServerSpec {
  type: string;         // 'cpx31', 'ccx33', etc. — lowercase, Hetzner slug
  family: 'cpx' | 'ccx';
  vcpus: number;
  ramGb: number;
  monthlyEur: number;   // approximate; don't take to 2 decimals as a contract
  dedicated: boolean;   // CCX = dedicated CPU, CPX = shared
}

export const CATALOG: ServerSpec[] = [
  // Shared (CPX) — good for I/O- and network-bound workloads
  { type: 'cpx11', family: 'cpx', vcpus: 2,  ramGb: 2,   monthlyEur: 4.5,   dedicated: false },
  { type: 'cpx21', family: 'cpx', vcpus: 3,  ramGb: 4,   monthlyEur: 7,     dedicated: false },
  { type: 'cpx31', family: 'cpx', vcpus: 4,  ramGb: 8,   monthlyEur: 12,    dedicated: false },
  { type: 'cpx41', family: 'cpx', vcpus: 8,  ramGb: 16,  monthlyEur: 24,    dedicated: false },
  { type: 'cpx51', family: 'cpx', vcpus: 16, ramGb: 32,  monthlyEur: 48,    dedicated: false },
  // Dedicated (CCX) — required for AES-NI media, G.729, real-time voice
  { type: 'ccx13', family: 'ccx', vcpus: 2,  ramGb: 8,   monthlyEur: 16,    dedicated: true  },
  { type: 'ccx23', family: 'ccx', vcpus: 4,  ramGb: 16,  monthlyEur: 32,    dedicated: true  },
  { type: 'ccx33', family: 'ccx', vcpus: 8,  ramGb: 32,  monthlyEur: 64,    dedicated: true  },
  { type: 'ccx43', family: 'ccx', vcpus: 16, ramGb: 64,  monthlyEur: 128,   dedicated: true  },
  { type: 'ccx53', family: 'ccx', vcpus: 32, ramGb: 128, monthlyEur: 256,   dedicated: true  },
  { type: 'ccx63', family: 'ccx', vcpus: 48, ramGb: 192, monthlyEur: 384,   dedicated: true  },
];

export const SPEC_BY_TYPE: Record<string, ServerSpec> = Object.fromEntries(
  CATALOG.map((s) => [s.type, s]),
);

export interface MetricOption {
  metric: string;                         // canonical metric key stored on the rule
  label: string;                          // chip label shown in the rule modal
  unit: 'percent' | 'count' | 'duration_ms' | 'time_window';
  defaultUp: number;
  defaultDown: number;
  description: string;
}

export interface ServiceProfile {
  service: string;
  serviceLabel: string;                   // human-friendly name shown in selects
  metricUnit: string;                     // legacy: human label for primary metric
  preferred: string[];                    // server types in ascending capacity
  capacityFor: Record<string, number>;    // per-node capacity for THIS service's metric, at target util
  metrics: MetricOption[];                // chips shown in the rule modal, in display order
  scaleDownEnabled: boolean;              // false → planner never drains; replicas/db patterns
  defaults: {                             // applied when creating a new rule for this service
    minInstances: number;
    maxInstances: number;
    cooldownSeconds: number;
  };
  notes?: string[];                       // info shown in the modal (e.g. db_read_replica caveats)
}

const COMMON_METRICS = {
  util:      { metric: 'cc_per_node_pct',  label: 'How busy the fleet is',  unit: 'percent' as const,     defaultUp: 75,  defaultDown: 30,  description: 'Active calls ÷ total capacity across the matched fleet.' },
  calls:     { metric: 'calls_total',      label: 'How many calls are live', unit: 'count' as const,       defaultUp: 1500, defaultDown: 500, description: 'Counts every call currently in progress across the fleet.' },
  forecast:  { metric: 'forecast_calls',   label: 'Expected calls soon',     unit: 'count' as const,       defaultUp: 1800, defaultDown: 600, description: 'Short-horizon forecast from recent call arrival rate.' },
  rps:       { metric: 'req_per_sec',      label: 'Requests per second',     unit: 'count' as const,       defaultUp: 800,  defaultDown: 200, description: 'Aggregate HTTP requests/sec across backend nodes.' },
  queue:     { metric: 'queue_depth',      label: 'Jobs waiting in queue',   unit: 'count' as const,       defaultUp: 120,  defaultDown: 30,  description: 'Pending jobs across BullMQ queues.' },
  regs:      { metric: 'sip_registrations', label: 'Active registrations',   unit: 'count' as const,       defaultUp: 4000, defaultDown: 1000, description: 'Live SIP registrations on the proxy fleet.' },
  read_qps:  { metric: 'db_read_qps',      label: 'DB read queries/sec',     unit: 'count' as const,       defaultUp: 5000, defaultDown: 1000, description: 'Read queries/sec across replicas.' },
  rep_lag:   { metric: 'replica_lag_ms',   label: 'Replica lag',             unit: 'duration_ms' as const, defaultUp: 2000, defaultDown: 200, description: 'Replication delay relative to primary, in milliseconds.' },
  cpu:       { metric: 'cpu_pct',          label: 'CPU on the servers',     unit: 'percent' as const,     defaultUp: 70,  defaultDown: 25,  description: 'Average CPU across all running nodes for this service.' },
  time:      { metric: 'time_window',      label: 'Time of day',             unit: 'time_window' as const, defaultUp: 0,   defaultDown: 0,   description: 'Schedule-based: provision/drain on a clock window.' },
};

/**
 * Per-service profiles. Capacity numbers are intentionally conservative so the
 * planner's additions are rarely underpowered. Shrink the headroom constant at
 * the call site, not here.
 */
export const PROFILES: Record<string, ServiceProfile> = {
  freeswitch: {
    service: 'freeswitch',
    serviceLabel: 'FreeSWITCH',
    metricUnit: 'concurrent_calls',
    // FreeSWITCH needs dedicated CPU: media transcoding, AES-NI for SRTP, steady RTP timing
    preferred: ['ccx13', 'ccx23', 'ccx33', 'ccx43', 'ccx53', 'ccx63'],
    capacityFor: {
      ccx13:  200,
      ccx23:  500,
      ccx33: 1200,
      ccx43: 2500,
      ccx53: 5000,
      ccx63: 8000,
    },
    metrics: [COMMON_METRICS.util, COMMON_METRICS.calls, COMMON_METRICS.forecast, COMMON_METRICS.cpu, COMMON_METRICS.time],
    scaleDownEnabled: true,
    defaults: { minInstances: 2, maxInstances: 12, cooldownSeconds: 300 },
  },
  media: {
    service: 'media',
    serviceLabel: 'Media',
    metricUnit: 'concurrent_calls',
    preferred: ['ccx13', 'ccx23', 'ccx33', 'ccx43'],
    capacityFor: { ccx13: 300, ccx23: 700, ccx33: 1500, ccx43: 3000 },
    metrics: [COMMON_METRICS.util, COMMON_METRICS.calls, COMMON_METRICS.forecast, COMMON_METRICS.cpu, COMMON_METRICS.time],
    scaleDownEnabled: true,
    defaults: { minInstances: 2, maxInstances: 8, cooldownSeconds: 300 },
  },
  backend: {
    service: 'backend',
    serviceLabel: 'Backend API',
    metricUnit: 'req_per_sec',
    // API nodes are I/O-bound; CPX is fine and cheaper
    preferred: ['cpx21', 'cpx31', 'cpx41', 'cpx51'],
    capacityFor: { cpx21: 400, cpx31: 1000, cpx41: 2500, cpx51: 5000 },
    metrics: [COMMON_METRICS.util, COMMON_METRICS.rps, COMMON_METRICS.cpu, COMMON_METRICS.time],
    scaleDownEnabled: true,
    defaults: { minInstances: 2, maxInstances: 6, cooldownSeconds: 180 },
  },
  worker: {
    service: 'worker',
    serviceLabel: 'Worker',
    metricUnit: 'jobs_per_sec',
    preferred: ['cpx11', 'cpx21', 'cpx31', 'cpx41'],
    capacityFor: { cpx11: 50, cpx21: 150, cpx31: 400, cpx41: 900 },
    metrics: [COMMON_METRICS.util, COMMON_METRICS.queue, COMMON_METRICS.cpu, COMMON_METRICS.time],
    scaleDownEnabled: true,
    defaults: { minInstances: 1, maxInstances: 4, cooldownSeconds: 240 },
  },
  sip_proxy: {
    service: 'sip_proxy',
    serviceLabel: 'SIP Proxy',
    metricUnit: 'sip_registrations',
    preferred: ['cpx21', 'cpx31', 'cpx41'],
    capacityFor: { cpx21: 800, cpx31: 2000, cpx41: 5000 },
    metrics: [COMMON_METRICS.util, COMMON_METRICS.regs, COMMON_METRICS.cpu, COMMON_METRICS.time],
    scaleDownEnabled: true,
    defaults: { minInstances: 2, maxInstances: 6, cooldownSeconds: 300 },
  },
  db_read_replica: {
    service: 'db_read_replica',
    serviceLabel: 'DB read replica',
    metricUnit: 'db_read_qps',
    // DB replicas need consistent CPU + RAM — dedicated CCX
    preferred: ['ccx23', 'ccx33', 'ccx43'],
    capacityFor: { ccx23: 4000, ccx33: 9000, ccx43: 20000 },
    metrics: [COMMON_METRICS.read_qps, COMMON_METRICS.rep_lag, COMMON_METRICS.cpu, COMMON_METRICS.time],
    scaleDownEnabled: false,
    defaults: { minInstances: 2, maxInstances: 5, cooldownSeconds: 600 },
    notes: [
      'Scale-down disabled. Replicas are never auto-drained; remove manually.',
      'Longer cooldown (default 600s) to let new replicas finish initial sync.',
      'Min ≥ 2 recommended for HA.',
      'DB primaries are alert-only — this rule does not provision or modify them.',
    ],
  },
};

// Cluster-shaping constants (planner heuristics)
export const MIN_CLUSTER_SIZE = 2;       // HA floor: never plan a cluster of 1 except when demand collapses to ~0
export const DEFAULT_HEADROOM = 1.3;      // target demand × 1.3 so bursts don't page
export const OPS_SWEET_SPOT_MIN = 2;      // if you can fit demand in this range, use it
export const OPS_SWEET_SPOT_MAX = 10;     // beyond this, jump to a bigger type to reduce node count
