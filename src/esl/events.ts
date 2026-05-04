import { eslClient } from './client';
import { db } from '../db/client';
import { calls, carriers, users, leads, tenants, plans, rateGroups, rateCards, dids } from '../db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { publishCallRinging, publishCallEnded, publishAgentStatus, publishCampaignDashboard } from '../ws/publisher';
import { billingQueue } from '../lib/queue';
import { logger } from '../lib/logger';

// Helper: find call by freeswitchUuid, or fall back to matching by channel variable or caller+callee.
// If no row exists and this is an A-leg from sofia, insert a new row so softphone calls
// (which have no backend pre-row) still appear in the call trace.
async function findAndLinkCall(uuid: string, headers: Record<string, string>) {
  // First try direct UUID match
  const [existing] = await db.select({ id: calls.id }).from(calls)
    .where(eq(calls.freeswitchUuid, uuid)).limit(1);
  if (existing) return true; // already linked

  // Try matching by treepbx_call_id channel variable (set by dialer originate)
  const callId = headers['variable_treepbx_call_id'];
  if (callId) {
    const result = await db.update(calls).set({ freeswitchUuid: uuid })
      .where(and(eq(calls.id, callId), isNull(calls.freeswitchUuid)));
    if ((result as any).rowCount > 0) {
      logger.info({ uuid, callId }, 'Linked FreeSWITCH UUID to call via treepbx_call_id');
      return true;
    }
  }

  const caller = headers['Caller-Caller-ID-Number'] || headers['variable_sip_from_user'];
  const callee = headers['Caller-Destination-Number'] || headers['variable_sip_to_user'];

  // Fall back: match a ringing call without a freeswitchUuid by caller + callee
  if (caller || callee) {
    const conditions: any[] = [isNull(calls.freeswitchUuid), eq(calls.status, 'ringing')];
    if (caller) conditions.push(eq(calls.callerId, caller));
    if (callee) conditions.push(eq(calls.calleeNumber, callee));

    const result = await db.update(calls).set({ freeswitchUuid: uuid })
      .where(and(...conditions));
    if ((result as any).rowCount > 0) {
      logger.info({ uuid, caller, callee }, 'Linked FreeSWITCH UUID to call via caller/callee match');
      return true;
    }
  }

  // Nothing matched. Insert a new row for the A-leg of softphone / DID calls
  // that don't go through the dialer or WS click-to-call paths. Skip B-legs
  // (peer channel created by an originate) so each logical call gets one row.
  const isPeerLeg = !!headers['variable_originator'];
  if (isPeerLeg) return false;

  const channelName = headers['Channel-Name'] || '';
  if (!channelName.startsWith('sofia/')) return false;
  if (!caller || !callee) return false;

  const isInternal = channelName.startsWith('sofia/internal/');
  const direction = isInternal ? 'outbound' : 'inbound';

  let tenantId: string | null = null;
  let agentId: string | null = null;
  let didId: string | null = null;

  if (isInternal) {
    const sipFromUser = headers['variable_sip_from_user'] || '';
    if (sipFromUser) {
      const [u] = await db.select({ id: users.id, tenantId: users.tenantId })
        .from(users).where(eq(users.sipUsername, sipFromUser)).limit(1);
      if (u?.tenantId) {
        tenantId = u.tenantId;
        agentId = u.id;
      }
    }
  } else {
    const [d] = await db.select({ id: dids.id, tenantId: dids.tenantId })
      .from(dids).where(eq(dids.number, callee)).limit(1);
    if (d) {
      tenantId = d.tenantId;
      didId = d.id;
    }
  }

  if (!tenantId) {
    logger.warn({ uuid, channelName, caller, callee }, 'ESL: cannot insert call, tenant not resolved');
    return false;
  }

  try {
    await db.insert(calls).values({
      freeswitchUuid: uuid,
      tenantId,
      direction,
      callerId: caller,
      calleeNumber: callee,
      status: 'ringing',
      agentId,
      didId,
      startedAt: new Date(),
    });
    logger.info({ uuid, tenantId, direction, caller, callee, agentId, didId }, 'ESL: inserted call from CHANNEL_CREATE');
    return true;
  } catch (err) {
    logger.error({ uuid, err }, 'ESL: failed to insert call');
    return false;
  }
}

// Track wrap-up timers so we can cancel on re-dial
const wrapUpTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function startESLEventListener() {
  // Prevent duplicate listeners
  if (eslClient.listenerCount('event') > 0) return;

  eslClient.on('event', async (headers: Record<string, string>) => {
    const eventName = headers['Event-Name'];
    if (['CHANNEL_CREATE', 'CHANNEL_ANSWER', 'CHANNEL_HANGUP', 'CHANNEL_BRIDGE'].includes(eventName)) {
      logger.info({ eventName, uuid: headers['Unique-ID'], caller: headers['Caller-Caller-ID-Number'], callee: headers['Caller-Destination-Number'], hangupCause: headers['Hangup-Cause'], callId: headers['variable_treepbx_call_id'] }, `[ESL] ${eventName}`);
    }
    const uuid = headers['Unique-ID'];

    try {
      switch (eventName) {
        case 'CHANNEL_CREATE': {
          logger.debug({ uuid, caller: headers['Caller-Caller-ID-Number'] }, 'Channel created');
          // Link FreeSWITCH UUID to dialer-created calls that don't have one yet
          if (uuid) {
            await findAndLinkCall(uuid, headers);
          }
          break;
        }

        case 'CHANNEL_ANSWER': {
          if (uuid) {
            await findAndLinkCall(uuid, headers);

            // Extract SIP and media details from channel variables
            const codec = headers['variable_read_codec'] || headers['variable_write_codec'] || null;
            const sipUserAgent = headers['variable_sip_user_agent'] || null;
            const carrier = headers['variable_sip_gateway_name'] || null;
            const carrierIp = headers['variable_sip_network_ip'] || headers['variable_remote_media_ip'] || null;
            const sipFromUri = headers['variable_sip_from_uri'] || headers['variable_sip_full_from'] || null;
            const sipToUri = headers['variable_sip_to_uri'] || headers['variable_sip_full_to'] || null;

            await db.update(calls).set({
              status: 'answered',
              answeredAt: new Date(),
              ...(carrier && { carrier }),
              ...(carrierIp && { carrierIp }),
              ...(codec && { codec }),
              ...(sipUserAgent && { userAgent: sipUserAgent }),
              ...(sipFromUri && { sipFromUri }),
              ...(sipToUri && { sipToUri }),
            }).where(eq(calls.freeswitchUuid, uuid));

            // Notify campaign dashboard on answer
            const callId = headers['variable_treepbx_call_id'];
            const tenantIdVar = headers['variable_treepbx_tenant_id'];
            if (tenantIdVar) publishCampaignDashboard(tenantIdVar);
          }
          break;
        }

        case 'CHANNEL_HANGUP': {
          if (uuid) {
            await findAndLinkCall(uuid, headers);
            const hangupCause = headers['Hangup-Cause'] ?? 'NORMAL_CLEARING';

            await db.update(calls).set({
              status: 'completed',
              endedAt: new Date(),
              hangupCause,
            }).where(eq(calls.freeswitchUuid, uuid));

            // Get the call to find tenant/agent for WS events
            const [call] = await db.select().from(calls)
              .where(eq(calls.freeswitchUuid, uuid)).limit(1);

            if (call) {
              // Notify campaign dashboard of state change
              if (call.campaignId) publishCampaignDashboard(call.tenantId);

              publishCallEnded(call.tenantId, call.agentId ?? '', {
                callId: call.id,
                duration: 0,
                hangupCause,
              });

              if (call.agentId) {
                const agentId = call.agentId;
                const tenantId = call.tenantId;
                const isFailedCall = hangupCause !== 'NORMAL_CLEARING' && hangupCause !== 'ORIGINATOR_CANCEL';

                if (isFailedCall) {
                  // Failed call — set agent back to available immediately (no wrap-up needed)
                  await db.update(users).set({ status: 'available', statusChangedAt: new Date() }).where(eq(users.id, agentId));
                  publishAgentStatus(tenantId, agentId, 'available');
                  logger.info({ agentId, hangupCause }, 'Agent set to available (call failed)');
                } else {
                  // Normal call ended — wrap-up then auto-available
                  publishAgentStatus(tenantId, agentId, 'wrap_up');
                  await db.update(users).set({ status: 'wrap_up', statusChangedAt: new Date() }).where(eq(users.id, agentId));

                  // Clear any existing wrap-up timer for this agent
                  const existingTimer = wrapUpTimers.get(agentId);
                  if (existingTimer) clearTimeout(existingTimer);

                  const wrapUpMs = 30_000; // default 30s wrap-up
                  const timer = setTimeout(async () => {
                    wrapUpTimers.delete(agentId);
                    try {
                      const [agent] = await db.select({ status: users.status }).from(users).where(eq(users.id, agentId));
                      if (agent?.status === 'wrap_up') {
                        await db.update(users).set({ status: 'available', statusChangedAt: new Date() }).where(eq(users.id, agentId));
                        publishAgentStatus(tenantId, agentId, 'available');
                        logger.info({ agentId }, 'Agent auto-transitioned to available after wrap-up');
                      }
                    } catch (err) {
                      logger.error({ agentId, err }, 'Failed to auto-transition agent');
                    }
                  }, wrapUpMs);
                  wrapUpTimers.set(agentId, timer);
                }
              }

              // Update lead status based on call result
              if (call.leadId) {
                const retryableCauses = ['USER_BUSY', 'NO_ANSWER', 'NORMAL_TEMPORARY_FAILURE', 'RECOVERY_ON_TIMER_EXPIRE', 'CALL_REJECTED', 'NO_USER_RESPONSE'];
                const permanentFailCauses = ['UNALLOCATED_NUMBER', 'NO_ROUTE_DESTINATION', 'INVALID_NUMBER_FORMAT', 'NUMBER_CHANGED'];
                const isSuccess = hangupCause === 'NORMAL_CLEARING' || hangupCause === 'ORIGINATOR_CANCEL';
                const isRetryable = retryableCauses.includes(hangupCause);

                // Fetch current lead to check attempts
                const [currentLead] = await db.select({ attempts: leads.attempts, maxAttempts: leads.maxAttempts })
                  .from(leads).where(eq(leads.id, call.leadId));
                const newAttempts = (currentLead?.attempts ?? 0) + 1;
                const maxAttempts = currentLead?.maxAttempts ?? 3;
                const exhausted = newAttempts >= maxAttempts;

                let leadStatus: string;
                let nextAttemptAt: Date | null = null;

                if (isSuccess) {
                  leadStatus = 'completed';
                } else if (permanentFailCauses.includes(hangupCause)) {
                  leadStatus = 'skipped';
                } else if (isRetryable && !exhausted) {
                  leadStatus = 'retry';
                  nextAttemptAt = new Date(Date.now() + 60 * 1000);
                } else {
                  leadStatus = 'skipped';
                }

                await db.update(leads).set({
                  status: leadStatus,
                  attempts: newAttempts,
                  lastAttemptAt: new Date(),
                  ...(nextAttemptAt && { nextAttemptAt }),
                }).where(eq(leads.id, call.leadId));

                logger.info({ leadId: call.leadId, hangupCause, newAttempts, maxAttempts, leadStatus }, 'Lead status updated');
              }
            }
          }
          break;
        }

        // CHANNEL_HANGUP_COMPLETE has all channel variables including duration, codec, quality
        case 'CHANNEL_HANGUP_COMPLETE': {
          if (uuid) {
            const duration = parseInt(headers['variable_duration'] ?? '0');
            const billSec = parseInt(headers['variable_billsec'] ?? '0');

            const codec = headers['variable_read_codec'] || headers['variable_write_codec'] || null;
            const sipUserAgent = headers['variable_sip_user_agent'] || null;
            const carrier = headers['variable_sip_gateway_name'] || null;
            const carrierIp = headers['variable_sip_network_ip'] || headers['variable_remote_media_ip'] || null;
            const sipFromUri = headers['variable_sip_from_uri'] || null;
            const sipToUri = headers['variable_sip_to_uri'] || null;
            const mos = headers['variable_rtp_audio_in_mos'] ? parseFloat(headers['variable_rtp_audio_in_mos']) : null;
            const jitterMs = headers['variable_rtp_audio_in_jitter_loss_rate'] ? parseFloat(headers['variable_rtp_audio_in_jitter_loss_rate']) : null;
            const qualityPct = headers['variable_rtp_audio_in_quality_percentage'] ? parseFloat(headers['variable_rtp_audio_in_quality_percentage']) : null;
            const packetLossPct = qualityPct !== null ? Math.round((100 - qualityPct) * 100) / 100 : null;

            // AMD result — set by execute_on_avmd_beep when mod_avmd detects
            // voicemail. If the channel ran AMD but never tripped, infer
            // 'human' from a non-trivial billsec on a connected call.
            const ranAmd = headers['variable_avmd-inbound-channel'] === 'true';
            const amdResult = headers['variable_amd_result']
              ?? (ranAmd && hangupCause === 'NORMAL_CLEARING' && billSec > 5 ? 'human' : null);

            logger.info({ uuid, duration, billSec, codec, carrier, mos, amdResult }, '[ESL] HANGUP_COMPLETE details');

            await db.update(calls).set({
              durationSeconds: duration,
              talkTimeSeconds: billSec,
              ...(carrier && { carrier }),
              ...(carrierIp && { carrierIp }),
              ...(codec && { codec }),
              ...(sipUserAgent && { userAgent: sipUserAgent }),
              ...(sipFromUri && { sipFromUri }),
              ...(sipToUri && { sipToUri }),
              ...(mos && { mos: String(mos) }),
              ...(jitterMs && { jitterMs: String(jitterMs) }),
              ...(packetLossPct && { packetLossPct: String(packetLossPct) }),
              ...(amdResult && { amdResult }),
            }).where(eq(calls.freeswitchUuid, uuid));

            // Dispatch billing if call had duration
            if (billSec > 0) {
              try {
                const [call] = await db.select({
                  id: calls.id,
                  tenantId: calls.tenantId,
                  direction: calls.direction,
                  calleeNumber: calls.calleeNumber,
                  callerId: calls.callerId,
                }).from(calls).where(eq(calls.freeswitchUuid, uuid)).limit(1);

                if (call) {
                  // Look up rate: tenant → plan → rateGroup → rateCard
                  const [tenant] = await db.select({ planId: tenants.planId }).from(tenants).where(eq(tenants.id, call.tenantId));
                  let ratePerMinute = '0';

                  if (tenant?.planId) {
                    const [plan] = await db.select({ rateGroupId: plans.rateGroupId }).from(plans).where(eq(plans.id, tenant.planId));
                    if (plan?.rateGroupId) {
                      // Determine direction and destination country code for rate lookup
                      const direction = call.direction === 'inbound' ? 'inbound' : 'outbound';
                      const number = direction === 'outbound' ? (call.calleeNumber ?? '') : (call.callerId ?? '');
                      // Extract country code prefix (try +1, +44, +91, etc.)
                      const cleaned = number.replace(/[\s\-()]/g, '').replace(/^00/, '+').replace(/^\+/, '');
                      // Find matching rate card by longest prefix match
                      const allCards = await db.select().from(rateCards)
                        .where(and(eq(rateCards.rateGroupId, plan.rateGroupId), eq(rateCards.direction, direction)));
                      const sorted = allCards.sort((a, b) => (b.countryCode?.length ?? 0) - (a.countryCode?.length ?? 0));
                      const match = sorted.find((c) => cleaned.startsWith(c.countryCode.replace('+', '')));
                      if (match) {
                        ratePerMinute = match.ratePerMinute;
                      }
                    }
                  }

                  if (parseFloat(ratePerMinute) > 0) {
                    await billingQueue.add('bill-call', {
                      callId: call.id,
                      tenantId: call.tenantId,
                      durationSeconds: billSec,
                      ratePerMinute,
                    });
                    logger.info({ callId: call.id, ratePerMinute, billSec }, 'Billing job dispatched');
                  }
                }
              } catch (err) {
                logger.error({ uuid, err }, 'Failed to dispatch billing job');
              }
            }
          }
          break;
        }

        case 'CHANNEL_BRIDGE': {
          logger.debug({ uuid }, 'Channel bridged');
          break;
        }

        case 'DTMF': {
          const digit = headers['DTMF-Digit'];
          logger.debug({ uuid, digit }, 'DTMF received');
          break;
        }

        case 'RECORD_START': {
          logger.debug({ uuid, path: headers['Record-File-Path'] }, 'Recording started');
          break;
        }

        case 'RECORD_STOP': {
          logger.debug({ uuid, path: headers['Record-File-Path'] }, 'Recording stopped');
          break;
        }

        case 'CUSTOM': {
          const subclass = headers['Event-Subclass'];
          if (subclass === 'sofia::gateway_state') {
            const gateway = headers['Gateway'] ?? '';
            const state = headers['State'] ?? '';
            const gwName = gateway.includes('::') ? gateway.split('::')[1] : gateway;
            const regStatus = state === 'REGED' ? 'registered' : state === 'UNREGED' || state === 'FAIL_WAIT' ? 'failed' : 'unregistered';
            logger.info({ gateway: gwName, state, regStatus }, '[ESL] Gateway registration change');
            try {
              await db.update(carriers)
                .set({ registrationStatus: regStatus, lastRegistered: regStatus === 'registered' ? new Date() : undefined })
                .where(eq(carriers.name, gwName));
            } catch {}
          }
          break;
        }
      }
    } catch (err) {
      logger.error({ eventName, uuid, err }, 'ESL event handler error');
    }
  });

  logger.info('ESL event listener started');
}
