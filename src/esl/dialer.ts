import { eq, and, sql, lte } from 'drizzle-orm';
import { db } from '../db/client';
import { campaigns, leads, calls, users } from '../db/schema';
import { originate } from './commands';
import { logger } from '../lib/logger';

interface DialerState {
  campaignId: string;
  tenantId: string;
  dialMode: string;
  dialRatio: number;
  interval: ReturnType<typeof setInterval> | null;
}

const activeCampaigns = new Map<string, DialerState>();

export async function startCampaignDialer(campaignId: string) {
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId));
  if (!campaign) return;

  const state: DialerState = {
    campaignId,
    tenantId: campaign.tenantId,
    dialMode: campaign.dialMode,
    dialRatio: parseFloat(campaign.dialRatio ?? '1'),
    interval: null,
  };

  // Dial loop runs every 2 seconds
  state.interval = setInterval(() => dialLoop(state), 2000);
  activeCampaigns.set(campaignId, state);
  logger.info({ campaignId, dialMode: state.dialMode }, 'Campaign dialer started');
}

export function stopCampaignDialer(campaignId: string) {
  const state = activeCampaigns.get(campaignId);
  if (state?.interval) {
    clearInterval(state.interval);
    activeCampaigns.delete(campaignId);
    logger.info({ campaignId }, 'Campaign dialer stopped');
  }
}

async function dialLoop(state: DialerState) {
  try {
    // Count available agents for this tenant
    const [{ available }] = await db.select({
      available: sql<number>`count(*)::int`,
    }).from(users).where(and(
      eq(users.tenantId, state.tenantId),
      eq(users.status, 'available'),
      eq(users.role, 'agent'),
    ));

    if (available === 0) return;

    // Calculate lines to dial
    let linesToDial = 0;
    if (state.dialMode === 'progressive') {
      linesToDial = available; // 1:1 ratio
    } else if (state.dialMode === 'predictive') {
      linesToDial = Math.ceil(available * state.dialRatio);
    } else if (state.dialMode === 'preview') {
      linesToDial = 1; // Preview: one at a time
    }

    // Count active calls for this campaign
    const [{ active }] = await db.select({
      active: sql<number>`count(*)::int`,
    }).from(calls).where(and(
      eq(calls.campaignId, state.campaignId),
      sql`${calls.status} IN ('ringing', 'answered')`,
    ));

    const needed = Math.max(0, linesToDial - active);
    if (needed === 0) return;

    // Pick leads to dial
    const leadsToCall = await db.select().from(leads).where(and(
      eq(leads.status, 'pending'),
      lte(leads.nextAttemptAt, new Date()),
    )).limit(needed);

    for (const lead of leadsToCall) {
      // Create CDR
      const [call] = await db.insert(calls).values({
        tenantId: state.tenantId,
        campaignId: state.campaignId,
        leadId: lead.id,
        direction: 'outbound',
        callerId: 'campaign', // TODO: resolve from DID group
        calleeNumber: lead.phone,
        callerName: `${lead.firstName} ${lead.lastName}`,
        status: 'ringing',
      }).returning();

      // Originate via FreeSWITCH
      originate(lead.phone, 'campaign');

      // Update lead
      await db.update(leads).set({
        status: 'dialing',
        attempts: (lead.attempts ?? 0) + 1,
        lastAttemptAt: new Date(),
      }).where(eq(leads.id, lead.id));

      logger.debug({ campaignId: state.campaignId, leadId: lead.id, phone: lead.phone }, 'Dialing lead');
    }
  } catch (err) {
    logger.error({ campaignId: state.campaignId, err }, 'Dialer loop error');
  }
}
