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
      multipleLines: campaigns.multipleLines,
      leadListId: campaigns.leadListId,
      leadListIds: campaigns.leadListIds,
      retryFailedLeads: campaigns.retryFailedLeads,
      leadListStrategy: campaigns.leadListStrategy,
      broadcastEnabled: campaigns.broadcastEnabled,
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

    // Sweeper: clean two classes of orphan CDRs that would otherwise gate
    // the dialer by inflating `active`:
    //  1. status='ringing' with no FS UUID, > 30s old — originate failed
    //     before FS produced a CHANNEL_CREATE event.
    //  2. status='answered' or 'ringing' > 5 min old — events.ts missed the
    //     hangup_complete and the CDR is permanently stuck.
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
    await db.update(calls).set({
      status: 'completed',
      hangupCause: sql`COALESCE(${calls.hangupCause}, 'STUCK_ORPHAN')`,
      endedAt: sql`COALESCE(${calls.endedAt}, NOW())`,
    }).where(and(
      eq(calls.campaignId, state.campaignId),
      inArray(calls.status, ['ringing', 'answered']),
      lte(calls.startedAt, sql`NOW() - INTERVAL '5 minutes'`),
    ));

    // Heal stuck 'on_call' agents — if they have NO active CDRs, flip them
    // back to 'available'. Failed originates leave the dialer's batch
    // 'on_call' set behind without a real call to anchor it.
    await db.execute(sql`
      UPDATE users SET status = 'available', status_changed_at = NOW()
      WHERE tenant_id = ${state.tenantId}
        AND status = 'on_call'
        AND role IN ('agent', 'supervisor')
        AND deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM calls c
          WHERE c.agent_id = users.id
            AND c.status IN ('ringing', 'answered')
        )
    `);

    // Count available agents AFTER the heal so we don't read a stale value.
    // Broadcast mode skips this gate — calls don't bridge to agents.
    const broadcastMode = !!freshCampaign.broadcastEnabled;
    const [{ available }] = await db.select({
      available: sql<number>`count(*)::int`,
    }).from(users).where(and(
      eq(users.tenantId, state.tenantId),
      eq(users.status, 'available'),
      inArray(users.role, ['agent', 'supervisor']),
      isNull(users.deletedAt),
    ));

    if (!broadcastMode && available === 0) return;

    // Lines per tick = dial_ratio × multiple_lines (both user-set on the
    // campaign form). Decouples the fan-out target from agent count so the
    // dialer can pump as hard as the carrier allows. Preview mode is still
    // pinned at 1 by definition.
    const multipleLines = freshCampaign.multipleLines ?? 1;
    const linesToDial = state.dialMode === 'preview'
      ? 1
      : Math.ceil(state.dialRatio * multipleLines);

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
    // can fan multiple lines onto the same agent. Broadcast mode skips this —
    // calls play audio and hang up, no agent bridging.
    const availableAgents = broadcastMode ? [] : await db.select({ id: users.id, sipUsername: users.sipUsername, firstName: users.firstName, lastName: users.lastName })
      .from(users)
      .where(and(
        eq(users.tenantId, state.tenantId),
        eq(users.status, 'available'),
        inArray(users.role, ['agent', 'supervisor']),
        isNull(users.deletedAt),
      ));
    if (!broadcastMode && availableAgents.length === 0) return;

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
      broadcastEnabled: campaigns.broadcastEnabled,
      broadcastAudioId: campaigns.broadcastAudioId,
      vmAudioId: campaigns.vmAudioId,
      transferEnabled: campaigns.transferEnabled,
      transferTarget: campaigns.transferTarget,
    }).from(campaigns).where(eq(campaigns.id, state.campaignId));
    const isBroadcast = !!campaign?.broadcastEnabled;

    // Resolve broadcast/voicemail audio file URLs once per tick. mod_http_cache
    // on the FS workers caches the file on first fetch, so the presigned URL
    // expiry only matters for that first call — subsequent calls play from
    // local disk. We use 1h expiry which comfortably outlives any single tick.
    let bcastAudioUrl: string | null = null;
    let bcastVmUrl: string | null = null;
    if (isBroadcast) {
      const { audioFiles } = await import('../db/schema');
      const { getFileUrl } = await import('../integrations/minio');
      const ids = [campaign?.broadcastAudioId, campaign?.vmAudioId].filter(Boolean) as string[];
      if (ids.length > 0) {
        const rows = await db.select({ id: audioFiles.id, key: audioFiles.minioKey })
          .from(audioFiles).where(inArray(audioFiles.id, ids));
        const byId = new Map(rows.map((r) => [r.id, r.key]));
        if (campaign?.broadcastAudioId) {
          const k = byId.get(campaign.broadcastAudioId);
          if (k) bcastAudioUrl = await getFileUrl(k, 3600);
        }
        if (campaign?.vmAudioId) {
          const k = byId.get(campaign.vmAudioId);
          if (k) bcastVmUrl = await getFileUrl(k, 3600);
        }
      }
      if (!bcastAudioUrl) {
        logger.warn({ campaignId: state.campaignId, broadcastAudioId: campaign?.broadcastAudioId }, 'broadcast: no audio file resolved — calls will be skipped');
      }
    }

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
      // No agent in broadcast mode — calls go straight to playback.
      const agent = availableAgents.length > 0 ? availableAgents[i % availableAgents.length] : null;

      // Resolve the caller-ID DID per lead so rotation/local-match actually
      // varies between calls in the same loop tick.
      const pickedDid = pickDidForLead(lead.phone) ?? tenantFallback;
      if (!pickedDid) {
        logger.warn({ campaignId: state.campaignId, leadId: lead.id }, 'Skipping dial — no caller ID available (DID group empty AND tenant has no active DIDs)');
        continue;
      }
      const effectiveCallerId = pickedDid.number;
      const outboundDidId = pickedDid.id;
      const callerName = agent ? `${agent.firstName} ${agent.lastName}`.trim() : 'Broadcast';

      // Create CDR
      const [call] = await db.insert(calls).values({
        tenantId: state.tenantId,
        campaignId: state.campaignId,
        leadId: lead.id,
        agentId: agent?.id ?? null,
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
          ...(agent ? [`treepbx_agent_id=${agent.id}`] : []),
          `treepbx_tenant_id=${state.tenantId}`,
        ];
        // AMD wiring (mod_avmd) — only used in non-broadcast mode. In broadcast
        // mode, the voice-broadcast.lua orchestrator runs avmd_start itself
        // after answer so it can synchronously read avmd_detect and branch
        // (HUMAN→play, MACHINE→hangup or wait-for-beep+VM).
        if (!isBroadcast && campaign?.amdEnabled) {
          varList.push(`execute_on_media='avmd start'`);
          varList.push(`execute_on_avmd_beep='set amd_result=machine'`);
          varList.push(`avmd-inbound-channel=true`);
          if (campaign.amdAction === 'hangup') {
            varList.push(`execute_on_avmd_beep_2='hangup MACHINE_DETECTED'`);
          }
        }

        // Broadcast channel vars — read by voice-broadcast.lua on answer.
        if (isBroadcast) {
          if (bcastAudioUrl) varList.push(`bcast_audio_url='${bcastAudioUrl}'`);
          if (bcastVmUrl) varList.push(`bcast_vm_url='${bcastVmUrl}'`);
          varList.push(`bcast_amd_enabled=${campaign?.amdEnabled ? 'true' : 'false'}`);
          varList.push(`bcast_amd_timeout_ms=${campaign?.amdTimeoutMs ?? 3500}`);
          varList.push(`bcast_amd_action=${campaign?.amdAction ?? 'hangup'}`);
          if (campaign?.amdTransferTarget) varList.push(`bcast_amd_xfer_target=${campaign.amdTransferTarget}`);
          varList.push(`bcast_xfer_enabled=${campaign?.transferEnabled ? 'true' : 'false'}`);
          if (campaign?.transferTarget) varList.push(`bcast_xfer_target=${campaign.transferTarget}`);
          varList.push(`bcast_xfer_digit=1`);
        }
        const vars = varList.join(',');

        // Build failover dial string: try each gateway in order
        const dialString = gateways
          .map(gw => `sofia/gateway/${gw}/${lead.phone}`)
          .join('|');

        // Broadcast mode: hand off to voice-broadcast.lua on answer. The lua
        // reads bcast_* channel vars and orchestrates AMD detection, audio
        // playback (via mod_http_cache from R2 presigned URL), DTMF capture
        // for press-1 transfer, and voicemail-beep wait + drop.
        let bridgeApp: string;
        if (isBroadcast) {
          if (!bcastAudioUrl) {
            // No audio resolved — skip this lead, restore status, free CDR.
            await db.update(calls).set({ status: 'failed', hangupCause: 'NO_BROADCAST_AUDIO', endedAt: new Date() }).where(eq(calls.id, call.id));
            await db.update(leads).set({ status: 'pending' }).where(eq(leads.id, lead.id));
            continue;
          }
          bridgeApp = `&lua(voice-broadcast.lua)`;
        } else {
          // Non-broadcast — agent is guaranteed to be set (loop only runs
          // when availableAgents.length > 0 in non-broadcast mode).
          const agentExtFs = agent!.sipUsername || agent!.id;
          bridgeApp = `&bridge(user/${agentExtFs})`;
        }
        const cmd = `originate {${vars}}${dialString} ${bridgeApp}`;
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

      // Notify agent via WebSocket — deliver the call to their desktop.
      // Skipped in broadcast mode (no agent attached to the call).
      if (agent) {
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
          sendToAgent(agent.id, 'campaign:call', {
            callId: call.id,
            campaignId: state.campaignId,
            leadId: lead.id,
            leadName: `${lead.firstName ?? ''} ${lead.lastName ?? ''}`.trim(),
            leadPhone: lead.phone,
            leadCompany: lead.company,
          });
        }
      }

      // Update lead status
      await db.update(leads).set({
        status: 'dialing',
        attempts: (lead.attempts ?? 0) + 1,
        lastAttemptAt: new Date(),
        assignedAgentId: agent?.id ?? null,
      }).where(eq(leads.id, lead.id));

      logger.info({ campaignId: state.campaignId, leadId: lead.id, phone: lead.phone, agentId: agent?.id ?? null, callId: call.id, broadcast: isBroadcast }, 'Campaign: dialing lead');
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
