import { eq, and, sql, lte, isNull, inArray, asc } from 'drizzle-orm';
import { db } from '../db/client';
import { campaigns, leads, calls, users, byocCarriers, dids, didGroups, carriers } from '../db/schema';
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
  // Caller-ID rotation cursor — incremented per-call for round_robin/sequential.
  // In-memory only; resets when the dialer restarts (acceptable; rotation is
  // for SHAKEN/spam-likely mitigation, not strict fairness).
  didCallerIdIndex: number;
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
    didCallerIdIndex: 0,
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

    // Sweeper: any CDR for this campaign that's been stuck in 'ringing' with
    // no FreeSWITCH UUID for >30s is an orphan — the originate either failed
    // before FS produced a CHANNEL_CREATE event, or events.ts never linked it.
    // Mark these failed so they stop counting against `active` (and the
    // dialer can keep dialing toward the linesToDial target).
    await db.update(calls).set({
      status: 'failed',
      hangupCause: 'ORIGINATE_TIMEOUT',
      endedAt: new Date(),
    }).where(and(
      eq(calls.campaignId, state.campaignId),
      eq(calls.status, 'ringing'),
      isNull(calls.freeswitchUuid),
      lte(calls.startedAt, sql`NOW() - INTERVAL '30 seconds'`),
    ));

    if (available === 0) return;

    // Lines per tick = dial_ratio × available_agents. Preview mode is the
    // exception (always 1, agent reviews before dialing).
    const linesToDial = state.dialMode === 'preview'
      ? 1
      : Math.ceil(available * state.dialRatio);

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
        .where(and(...retryConditions, inArray(leads.status, ['retry', 'failed', 'busy', 'no_answer'])))
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

    // Find every available agent (no per-tick limit) so a predictive ratio > 1
    // can fan multiple lines onto the same agent.
    const availableAgents = await db.select({ id: users.id, sipUsername: users.sipUsername, firstName: users.firstName, lastName: users.lastName })
      .from(users)
      .where(and(
        eq(users.tenantId, state.tenantId),
        eq(users.status, 'available'),
        inArray(users.role, ['agent', 'supervisor']),
        isNull(users.deletedAt),
      ));
    if (availableAgents.length === 0) return;

    // Resolve campaign's outbound caller ID from DID group
    const [campaign] = await db.select({
      didGroupId: campaigns.didGroupId,
      byocCarrierId: campaigns.byocCarrierId,
      byocRouting: campaigns.byocRouting,
      ringTimeoutSeconds: campaigns.ringTimeoutSeconds,
      rateCardId: campaigns.rateCardId,
      callerIdRotation: campaigns.callerIdRotation,
      amdEnabled: campaigns.amdEnabled,
      amdAction: campaigns.amdAction,
      amdTimeoutMs: campaigns.amdTimeoutMs,
      amdTransferTarget: campaigns.amdTransferTarget,
    }).from(campaigns).where(eq(campaigns.id, state.campaignId));

    // Caller-ID DID pool — when the campaign has a DID group, fetch every
    // active DID in the group (ordered by created_at for stable round-robin)
    // and rotate through them per-lead. Resolution per lead happens inside
    // the dial loop using `pickDidForLead` below.
    let groupDids: { id: string; number: string }[] = [];
    let groupCallerIdStrategy: string = 'fixed';
    if (campaign?.didGroupId) {
      groupDids = await db.select({ id: dids.id, number: dids.number })
        .from(dids)
        .where(and(eq(dids.didGroupId, campaign.didGroupId), eq(dids.active, true)))
        .orderBy(asc(dids.createdAt));
      const [grp] = await db.select({ callerIdStrategy: didGroups.callerIdStrategy })
        .from(didGroups).where(eq(didGroups.id, campaign.didGroupId));
      if (grp?.callerIdStrategy) groupCallerIdStrategy = grp.callerIdStrategy;
    }

    // Effective rotation: campaign override wins unless 'use_group_default'.
    // Frontend values: round_robin | sequential | random | local_match | use_group_default
    const camp = campaign?.callerIdRotation;
    const effectiveStrategy =
      camp && camp !== 'use_group_default'
        ? camp
        : (groupCallerIdStrategy === 'fixed' ? 'fixed' : groupCallerIdStrategy);

    function pickDidForLead(leadPhone: string): { id: string; number: string } | null {
      if (groupDids.length === 0) return null;
      switch (effectiveStrategy) {
        case 'random':
          return groupDids[Math.floor(Math.random() * groupDids.length)];
        case 'local_match': {
          // North-American area code: digit 1 (after +1) through 3.
          // For E.164 +1AAANNNXXXX → AAA = leadPhone.slice(2,5).
          const digits = leadPhone.replace(/\D/g, '');
          const npa = digits.startsWith('1') ? digits.slice(1, 4) : digits.slice(0, 3);
          const match = groupDids.find((d) => {
            const dd = d.number.replace(/\D/g, '');
            const dnpa = dd.startsWith('1') ? dd.slice(1, 4) : dd.slice(0, 3);
            return dnpa === npa;
          });
          if (match) return match;
          // Fall through to round-robin if no area-code match.
          return groupDids[state.didCallerIdIndex++ % groupDids.length];
        }
        case 'round_robin':
        case 'sequential':
          return groupDids[state.didCallerIdIndex++ % groupDids.length];
        case 'fixed':
        default:
          return groupDids[0];
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

    // Tenant-level fallback (single DID) for when the campaign has no DID
    // group configured. The campaign-DID-group path uses pickDidForLead(),
    // which already returns null when the group is empty.
    let tenantFallback: { id: string; number: string } | null = null;
    if (groupDids.length === 0) {
      const [tenantDid] = await db.select({ number: dids.number, id: dids.id })
        .from(dids)
        .where(and(eq(dids.tenantId, state.tenantId), eq(dids.active, true)))
        .orderBy(asc(dids.createdAt))
        .limit(1);
      if (tenantDid) tenantFallback = tenantDid;
    }

    // Predictive fan-out: fire every needed line, rotating agents round-robin.
    // With dial_ratio > 1, multiple bridges queue onto the same agent; the
    // first lead to answer wins, the rest fail with USER_BUSY (abandoned).
    // Cap is leadsToCall.length, which is already <= needed = linesToDial - active.
    for (let i = 0; i < leadsToCall.length; i++) {
      const lead = leadsToCall[i];
      const agent = availableAgents[i % availableAgents.length];

      // Resolve the caller-ID DID per lead so rotation/local-match actually
      // varies between calls in the same loop tick.
      const pickedDid = pickDidForLead(lead.phone) ?? tenantFallback;
      if (!pickedDid) {
        logger.warn({ campaignId: state.campaignId, leadId: lead.id }, 'Skipping dial — no caller ID available (DID group empty AND tenant has no active DIDs)');
        continue;
      }
      const effectiveCallerId = pickedDid.number;
      const outboundDidId = pickedDid.id;
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
        const varList = [
          `origination_caller_id_number=${effectiveCallerId}`,
          `origination_caller_id_name='${safeName}'`,
          `originate_timeout=${ringTimeout}`,
          `treepbx_call_id=${call.id}`,
          `treepbx_campaign_id=${state.campaignId}`,
          `treepbx_agent_id=${agent.id}`,
          `treepbx_tenant_id=${state.tenantId}`,
        ];
        // AMD wiring (mod_avmd) — start avmd at media negotiation. avmd fires
        // an avmd::beep event when it detects voicemail; we then set
        // amd_result=machine on the channel via execute_on_avmd_beep so it
        // surfaces on hangup_complete via variable_amd_result.
        if (campaign?.amdEnabled) {
          varList.push(`execute_on_media='avmd start'`);
          varList.push(`execute_on_avmd_beep='set amd_result=machine'`);
          varList.push(`avmd-inbound-channel=true`);
          if (campaign.amdAction === 'hangup') {
            varList.push(`execute_on_avmd_beep_2='hangup MACHINE_DETECTED'`);
          }
        }
        const vars = varList.join(',');

        // Originate call to lead, then bridge to agent extension
        // Build failover dial string: try each gateway in order
        const agentExtFs = agent.sipUsername || agent.id;
        const dialString = gateways
          .map(gw => `sofia/gateway/${gw}/${lead.phone}`)
          .join('|');
        const cmd = `originate {${vars}}${dialString} &bridge(user/${agentExtFs})`;
        // Async bgapi: when FS replies (with the BACKGROUND_JOB event), settle
        // the CDR. On +OK, link the FS UUID. On -ERR, mark the CDR failed
        // immediately (no more 30s orphan window) and free the agent + lead.
        eslClient.bgapi(cmd, async (success, body) => {
          try {
            if (success) {
              const fsUuid = body.replace(/^\+OK\s*/, '').trim();
              if (fsUuid) {
                await db.update(calls).set({ freeswitchUuid: fsUuid })
                  .where(and(eq(calls.id, call.id), isNull(calls.freeswitchUuid)));
              }
            } else {
              const cause = body.replace(/^-ERR\s*/, '').trim() || 'ORIGINATE_FAILED';
              await db.update(calls).set({
                status: 'failed',
                hangupCause: cause,
                endedAt: new Date(),
              }).where(and(eq(calls.id, call.id), eq(calls.status, 'ringing')));
              await db.update(leads).set({ status: 'skipped' }).where(eq(leads.id, lead.id));
              // Don't auto-flip the agent — they may still have other lines in this fan-out.
            }
          } catch (err) {
            logger.warn({ err, callId: call.id }, '[bgapi cb] failed to settle CDR');
          }
        });
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

      logger.info({ campaignId: state.campaignId, leadId: lead.id, phone: lead.phone, agentId: agent.id, callId: call.id }, 'Campaign: dialing lead');
    }

    // Flip every agent we just dispatched calls to → on_call, in a single
    // statement. With ratio=1000 this used to fire 1000 redundant per-call
    // updates against the same agent row.
    const dispatchedAgentIds = Array.from(new Set(leadsToCall.slice(0, availableAgents.length === 0 ? 0 : leadsToCall.length).map((_, i) => availableAgents[i % availableAgents.length].id)));
    if (dispatchedAgentIds.length > 0) {
      await db.update(users).set({ status: 'on_call', statusChangedAt: new Date() })
        .where(inArray(users.id, dispatchedAgentIds));
    }
  } catch (err) {
    logger.error({ campaignId: state.campaignId, err }, 'Dialer loop error');
  }
}
