/**
 * Autoscaler state helpers — thin wrapper over platform_settings + scaling_decisions.
 */

import { desc, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { platformSettings, scalingDecisions } from '../db/schema';

async function getSetting(key: string): Promise<string | null> {
  const [row] = await db.select().from(platformSettings).where(eq(platformSettings.key, key));
  return row?.value ?? null;
}

export async function isEnabled(): Promise<boolean> {
  return (await getSetting('autoscaler_enabled')) === 'true';
}

export async function isShadow(): Promise<boolean> {
  return (await getSetting('autoscaler_shadow_mode')) !== 'false';
}

export async function cooldownActive(): Promise<boolean> {
  const cooldownSec = Number((await getSetting('scale_cooldown_seconds')) ?? 300);
  const [row] = await db.select({ at: scalingDecisions.at })
    .from(scalingDecisions)
    .where(eq(scalingDecisions.kind, 'provision'))
    .orderBy(desc(scalingDecisions.at))
    .limit(1);
  if (!row?.at) return false;
  return Date.now() - row.at.getTime() < cooldownSec * 1000;
}

export async function getPerNodeCapacity(): Promise<number> {
  return Number((await getSetting('per_node_capacity_cc')) ?? 600);
}

export interface LogDecisionInput {
  kind: string;
  reason?: string;
  nodeId?: string;
  targetCc?: number;
  currentCc?: number;
  carrierCeiling?: number;
  shadow: boolean;
}

export async function logDecision(input: LogDecisionInput): Promise<void> {
  await db.insert(scalingDecisions).values({
    kind: input.kind,
    reason: input.reason ?? null,
    nodeId: input.nodeId ?? null,
    targetCc: input.targetCc ?? null,
    currentCc: input.currentCc ?? null,
    carrierCeiling: input.carrierCeiling ?? null,
    shadowMode: input.shadow ? 'true' : 'false',
  });
}
