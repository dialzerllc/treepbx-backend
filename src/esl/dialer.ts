import { eq, and, sql, lte, isNull, inArray, asc } from 'drizzle-orm';
import { db } from '../db/client';
import { campaigns, leads, calls, users, byocCarriers, dids, carriers } from '../db/schema';
import { sendToAgent } from '../ws/rooms';
import { eslClient } from './client';
import { logger } from '../lib/logger';

interface DialerState {
  campaignId: string;
  tenantId: string;
  dialMode: string;
  dialRatio: number;
  leadListId: string | null;
  leadListIds: string[];
  leadListStrategy: string;
  roundRobinIndex: number;
  interval: ReturnType<typeof setInterval> | null;
}

const activeCampaigns = new Map<string, DialerState>();

export async function startCampaignDialer(campaignId: string) {
  if (activeCampaigns.has(campaignId)) return; // Already running

  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId));
  if (!campaign || (campaign.status !== 'active' && campaign.status !== 'running')) return;

  const listIds = (campaign.leadListIds as string[] | null)?.filter(Boolean) ?? [];
  const state: DialerState = {
    campaignId,
    tenantId: campaign.tenantId,
    dialMode: campaign.dialMode,
    dialRatio: parseFloat(campaign.dialRatio ?? '1'),
    leadListId: campaign.leadListId,
    leadListIds: listIds.length > 0 ? listIds : (campaign.leadListId ? [campaign.leadListId] : []),
    leadListStrategy: (campaign as any).leadListStrategy ?? 'sequential',
    roundRobinIndex: 0,
    interval: null,
  };

  // Dial loop runs every 5 seconds
  state.interval = setInterval(() => dialLoop(state), 5000);
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

export function isDialerRunning(campaignId: string): boolean {
  return activeCampaigns.has(campaignId);
}

async function dialLoop(state: DialerState) {
  try {
    // Hot-reload campaign config from DB every loop (picks up lead list changes, dial mode, ratio, etc.)
    const [freshCampaign] = await db.select({
      status: campaigns.status,
      dialMode: campaigns.dialMode,
      dialRatio: campaigns.dialRatio,
      leadListId: campaigns.leadListId,
      leadListIds: campaigns.leadListIds,
      retryFailedLeads: campaigns.retryFailedLeads,
      leadListStrategy: campaigns.leadListStrategy,
    }).from(campaigns).where(eq(campaigns.id, state.campaignId));

    if (!freshCampaign || (freshCampaign.status !== 'running' && freshCampaign.status !== 'active')) {
      // Campaign was paused/stopped/deleted externally — auto-stop dialer
      logger.info({ campaignId: state.campaignId, status: freshCampaign?.status }, 'Campaign no longer running, auto-stopping dialer');
      stopCampaignDialer(state.campaignId);
      return;
    }

    // Update state with fresh values
    state.dialMode = freshCampaign.dialMode;
    state.dialRatio = parseFloat(freshCampaign.dialRatio ?? '1');
    const freshListIds = (freshCampaign.leadListIds as string[] | null)?.filter(Boolean) ?? [];
    state.leadListIds = freshListIds.length > 0 ? freshListIds : (freshCampaign.leadListId ? [freshCampaign.leadListId] : []);
    state.leadListStrategy = freshCampaign.leadListStrategy ?? 'sequential';

    // Count available agents for this tenant
    const [{ available }] = await db.select({
      available: sql<number>`count(*)::int`,
    }).from(users).where(and(
      eq(users.tenantId, state.tenantId),
      eq(users.status, 'available'),
      inArray(users.role, ['agent', 'supervisor']),
      isNull(users.deletedAt),
    ));

    if (available === 0) return;

    // Calculate lines to dial
    let linesToDial = 0;
    if (state.dialMode === 'progressive') {
      linesToDial = available;
    } else if (state.dialMode === 'predictive') {
      linesToDial = Math.ceil(available * state.dialRatio);
    } else if (state.dialMode === 'preview') {
      linesToDial = 1;
    } else {
      linesToDial = available; // Default
    }

    // Count active calls for this campaign
    const [{ active }] = await db.select({
      active: sql<number>`count(*)::int`,
    }).from(calls).where(and(
      eq(calls.campaignId, state.campaignId),
      inArray(calls.status, ['ringing', 'answered']),
    ));

    const needed = Math.max(0, linesToDial - active);
    if (needed === 0) return;

    // Build lead query conditions
    const baseConditions: any[] = [
      eq(leads.tenantId, state.tenantId),
      eq(leads.dnc, false),
      sql`(${leads.attempts} < ${leads.maxAttempts} OR ${leads.maxAttempts} IS NULL)`,
      sql`(${leads.nextAttemptAt} IS NULL OR ${leads.nextAttemptAt} <= NOW())`,
    ];

    // Apply lead list strategy
    const strategy = state.leadListStrategy;
    let listFilter: any = undefined;

    if (state.leadListIds.length > 0) {
      if (strategy === 'round_robin' && state.leadListIds.length > 1) {
        // Round Robin: pick from one list at a time, rotate each loop
        const currentList = state.leadListIds[state.roundRobinIndex % state.leadListIds.length];
        listFilter = eq(leads.leadListId, currentList);
        state.roundRobinIndex++;
      } else {
        listFilter = inArray(leads.leadListId, state.leadListIds);
      }
      baseConditions.push(listFilter);
    }

    // Sequential: order by list position in the array, then creation time
    const orderClauses = strategy === 'sequential' && state.leadListIds.length > 1
      ? [sql`array_position(ARRAY[${sql.join(state.leadListIds.map(id => sql`${id}`), sql`,`)}]::text[], ${leads.leadListId}::text)`, asc(leads.createdAt)]
      : [asc(leads.nextAttemptAt), asc(leads.createdAt)];

    // First: pick pending leads
    let leadsToCall = await db.select().from(leads)
      .where(and(...baseConditions, eq(leads.status, 'pending')))
      .orderBy(...orderClauses)
      .limit(needed);

    // Round Robin: if current list is empty, try next lists
    if (leadsToCall.length === 0 && strategy === 'round_robin' && state.leadListIds.length > 1) {
      for (let attempt = 1; attempt < state.leadListIds.length; attempt++) {
        const nextList = state.leadListIds[(state.roundRobinIndex - 1 + attempt) % state.leadListIds.length];
        const rrConditions = baseConditions.filter(c => c !== listFilter);
        rrConditions.push(eq(leads.leadListId, nextList));
        leadsToCall = await db.select().from(leads)
          .where(and(...rrConditions, eq(leads.status, 'pending')))
          .orderBy(asc(leads.createdAt))
          .limit(needed);
        if (leadsToCall.length > 0) break;
      }
    }

    // If no pending leads and retry is enabled, retry failed leads
    if (leadsToCall.length === 0 && freshCampaign.retryFailedLeads !== false) {
      // For retry, always use all lists (no round robin for retries)
      const retryConditions: any[] = [
        eq(leads.tenantId, state.tenantId),
        eq(leads.dnc, false),
        sql`(${leads.attempts} < ${leads.maxAttempts} OR ${leads.maxAttempts} IS NULL)`,
        sql`(${leads.nextAttemptAt} IS NULL OR ${leads.nextAttemptAt} <= NOW())`,
      ];
      if (state.leadListIds.length > 0) retryConditions.push(inArray(leads.leadListId, state.leadListIds));

      leadsToCall = await db.select().from(leads)
        .where(and(...retryConditions, inArray(leads.status, ['failed', 'busy', 'no_answer'])))
        .orderBy(asc(leads.lastAttemptAt), asc(leads.createdAt))
        .limit(needed);

      if (leadsToCall.length > 0) {
        logger.info({ campaignId: state.campaignId, count: leadsToCall.length }, 'Retrying failed leads');
      }
    }

    if (leadsToCall.length === 0) {
      logger.debug({ campaignId: state.campaignId }, 'No leads to dial');
      return;
    }

    // Find available agents
    const availableAgents = await db.select({ id: users.id, sipUsername: users.sipUsername, firstName: users.firstName, lastName: users.lastName })
      .from(users)
      .where(and(
        eq(users.tenantId, state.tenantId),
        eq(users.status, 'available'),
        inArray(users.role, ['agent', 'supervisor']),
        isNull(users.deletedAt),
      ))
      .limit(needed);

    // Resolve campaign's outbound caller ID from DID group
    const [campaign] = await db.select({
      didGroupId: campaigns.didGroupId,
      byocCarrierId: campaigns.byocCarrierId,
      byocRouting: campaigns.byocRouting,
      ringTimeoutSeconds: campaigns.ringTimeoutSeconds,
      rateCardId: campaigns.rateCardId,
    }).from(campaigns).where(eq(campaigns.id, state.campaignId));

    // Pick a DID for caller ID if a DID group is configured
    let outboundCallerId: string | null = null;
    let outboundDidId: string | null = null;
    if (campaign?.didGroupId) {
      const [did] = await db.select({ id: dids.id, number: dids.number })
        .from(dids)
        .where(and(eq(dids.didGroupId, campaign.didGroupId), eq(dids.active, true)))
        .limit(1);
      if (did) {
        outboundCallerId = did.number;
        outboundDidId = did.id;
      }
    }

    // Resolve carrier/gateway for origination with failover
    let gateways: string[] = [];
    let carrierName: string | null = null;
    let carrierIpAddr: string | null = null;

    if (campaign?.byocCarrierId) {
      // Tenant BYOC carrier takes priority
      const [carrier] = await db.select({ name: byocCarriers.name, host: byocCarriers.host })
        .from(byocCarriers).where(eq(byocCarriers.id, campaign.byocCarrierId));
      if (carrier) {
        gateways.push(carrier.name);
        carrierName = carrier.name;
        carrierIpAddr = carrier.host;
      }
    }

    // Use rate card's outbound carrier as preferred platform carrier
    if (campaign?.rateCardId && gateways.length === 0) {
      const { rateGroups } = await import('../db/schema');
      const [rateGroup] = await db.select({ outboundCarrierId: rateGroups.outboundCarrierId })
        .from(rateGroups).where(eq(rateGroups.id, campaign.rateCardId));
      if (rateGroup?.outboundCarrierId) {
        const [rateCarrier] = await db.select({ name: carriers.name, host: carriers.host })
          .from(carriers).where(eq(carriers.id, rateGroup.outboundCarrierId));
        if (rateCarrier) {
          gateways.push(rateCarrier.name);
          carrierName = rateCarrier.name;
          carrierIpAddr = rateCarrier.host;
        }
      }
    }

    // Query active platform carriers ordered by priority for failover
    const platformCarriers = await db.select({ name: carriers.name, host: carriers.host })
      .from(carriers)
      .where(and(
        eq(carriers.status, 'active'),
        inArray(carriers.direction, ['outbound', 'both']),
      ))
      .orderBy(asc(carriers.priority));

    for (const pc of platformCarriers) {
      if (!gateways.includes(pc.name)) {
        gateways.push(pc.name);
      }
    }

    // Fall back to env default if no carriers found
    if (gateways.length === 0) {
      const defaultGw = process.env.FS_DEFAULT_GATEWAY ?? 'OTB2';
      gateways.push(defaultGw);
    }

    if (!carrierName && platformCarriers.length > 0) {
      carrierName = platformCarriers[0].name;
      carrierIpAddr = platformCarriers[0].host;
    }

    const ringTimeout = campaign?.ringTimeoutSeconds ?? 25;

    for (let i = 0; i < leadsToCall.length && i < availableAgents.length; i++) {
      const lead = leadsToCall[i];
      const agent = availableAgents[i];

      const effectiveCallerId = outboundCallerId || agent.sipUsername || agent.id;
      const callerName = `${agent.firstName} ${agent.lastName}`.trim();

      // Create CDR
      const [call] = await db.insert(calls).values({
        tenantId: state.tenantId,
        campaignId: state.campaignId,
        leadId: lead.id,
        agentId: agent.id,
        didId: outboundDidId,
        direction: 'outbound',
        callerId: effectiveCallerId,
        callerName,
        calleeNumber: lead.phone,
        calleeName: `${lead.firstName ?? ''} ${lead.lastName ?? ''}`.trim() || lead.phone,
        status: 'ringing',
        startedAt: new Date(),
        carrier: carrierName,
        carrierIp: carrierIpAddr,
      }).returning();

      // Originate the call via FreeSWITCH ESL
      if (eslClient.isConnected()) {
        const safeName = callerName.replace(/[^a-zA-Z0-9 _-]/g, '');
        const vars = [
          `origination_caller_id_number=${effectiveCallerId}`,
          `origination_caller_id_name='${safeName}'`,
          `originate_timeout=${ringTimeout}`,
          `treepbx_call_id=${call.id}`,
          `treepbx_campaign_id=${state.campaignId}`,
          `treepbx_agent_id=${agent.id}`,
          `treepbx_tenant_id=${state.tenantId}`,
        ].join(',');

        // Originate call to lead, then bridge to agent extension
        // Build failover dial string: try each gateway in order
        const agentExtFs = agent.sipUsername || agent.id;
        const dialString = gateways
          .map(gw => `sofia/gateway/${gw}/${lead.phone}`)
          .join('|');
        const cmd = `originate {${vars}}${dialString} &bridge(user/${agentExtFs})`;
        logger.info({ cmd, callId: call.id, gateways }, 'ESL originate for campaign call');
        eslClient.bgapi(cmd);
      } else {
        // FreeSWITCH not connected — mark call as failed
        logger.error({ callId: call.id }, 'FreeSWITCH not connected, marking call as failed');
        await db.update(calls).set({
          status: 'failed',
          endedAt: new Date(),
          hangupCause: 'FREESWITCH_UNAVAILABLE',
        }).where(eq(calls.id, call.id));
        continue;
      }

      // Notify agent via WebSocket — deliver the call to their desktop
      const agentExt = agent.sipUsername;
      if (agentExt) {
        sendToAgent(agentExt, 'campaign:call', {
          callId: call.id,
          campaignId: state.campaignId,
          leadId: lead.id,
          leadName: `${lead.firstName ?? ''} ${lead.lastName ?? ''}`.trim(),
          leadPhone: lead.phone,
          leadCompany: lead.company,
        });
        // Also notify via user ID room
        sendToAgent(agent.id, 'campaign:call', {
          callId: call.id,
          campaignId: state.campaignId,
          leadId: lead.id,
          leadName: `${lead.firstName ?? ''} ${lead.lastName ?? ''}`.trim(),
          leadPhone: lead.phone,
          leadCompany: lead.company,
        });
      }

      // Update lead status
      await db.update(leads).set({
        status: 'dialing',
        attempts: (lead.attempts ?? 0) + 1,
        lastAttemptAt: new Date(),
        assignedAgentId: agent.id,
      }).where(eq(leads.id, lead.id));

      // Set agent to on_call
      await db.update(users).set({
        status: 'on_call',
        statusChangedAt: new Date(),
      }).where(eq(users.id, agent.id));

      logger.info({ campaignId: state.campaignId, leadId: lead.id, phone: lead.phone, agentId: agent.id, callId: call.id }, 'Campaign: dialing lead');
    }
  } catch (err) {
    logger.error({ campaignId: state.campaignId, err }, 'Dialer loop error');
  }
}
