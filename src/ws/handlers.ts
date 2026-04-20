import type { ServerWebSocket } from 'bun';
import type { WsData } from './rooms';
import { broadcastToRoom, sendToAgent } from './rooms';
import { logger } from '../lib/logger';
import { db } from '../db/client';
import { users, calls, chatMessages, dmMessages, dmConversations, chatReadMarkers } from '../db/schema';
import { eq, and, or } from 'drizzle-orm';
import { setAgentOnline, setAgentOffline, setCallState, delCallState, redis } from '../lib/redis';

// Cache user info for caller ID (Redis-backed with in-memory fallback)
const userInfoCache = new Map<string, { name: string; ext: string }>();
async function getUserInfo(userId: string): Promise<{ name: string; ext: string }> {
  if (userInfoCache.has(userId)) return userInfoCache.get(userId)!;
  const [u] = await db.select({ firstName: users.firstName, lastName: users.lastName, sipUsername: users.sipUsername })
    .from(users).where(eq(users.id, userId));
  const info = { name: u ? `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() : 'Unknown', ext: u?.sipUsername ?? '' };
  userInfoCache.set(userId, info);
  return info;
}

interface WsMessage {
  event: string;
  data?: unknown;
}

export async function handleMessage(ws: ServerWebSocket<WsData>, raw: string) {
  try {
    const msg: WsMessage = JSON.parse(raw);
    if (!msg.event || !msg.data) return;
    const { user } = ws.data;

    switch (msg.event) {
      case 'agent:set_status': {
        const { status } = msg.data as { status: string };
        // Update agent presence in Redis
        await setAgentOnline(user.sub, { status, tenantId: user.tenantId, updatedAt: Date.now() });
        // Broadcast to tenant room
        if (user.tenantId) {
          broadcastToRoom(`tenant:${user.tenantId}`, 'agent:status', {
            agentId: user.sub,
            status,
          });
        }
        break;
      }

      case 'chat:send':
      case 'chat:send_message': {
        const { channelId, content, parentId, fileUrl, fileName, fileSize, fileType } = msg.data as {
          channelId: string; content: string; parentId?: string;
          fileUrl?: string; fileName?: string; fileSize?: number; fileType?: string;
        };
        try {
          const [row] = await db.insert(chatMessages).values({
            tenantId: user.tenantId!,
            channelId,
            senderId: user.sub,
            content,
            parentId: parentId ?? undefined,
            fileUrl, fileName, fileSize, fileType,
          }).returning();

          const userInfo = await getUserInfo(user.sub);
          broadcastToRoom(`chat:${channelId}`, 'chat:message', {
            channelId,
            message: {
              ...row,
              senderFirstName: userInfo.name.split(' ')[0],
              senderLastName: userInfo.name.split(' ').slice(1).join(' '),
            },
          });
        } catch (err: any) {
          logger.error({ err: err.message }, 'Failed to persist chat message');
          broadcastToRoom(`chat:${channelId}`, 'chat:message', {
            channelId,
            message: {
              channelId, senderId: user.sub, content, parentId,
              fileUrl, fileName, fileSize, fileType,
              createdAt: new Date().toISOString(),
            },
          });
        }
        break;
      }

      case 'chat:dm_send': {
        const { conversationId, content, parentId, fileUrl, fileName, fileSize, fileType } = msg.data as {
          conversationId: string; content: string; parentId?: string;
          fileUrl?: string; fileName?: string; fileSize?: number; fileType?: string;
        };
        try {
          const [row] = await db.insert(dmMessages).values({
            conversationId,
            senderId: user.sub,
            content,
            parentId: parentId ?? undefined,
            fileUrl, fileName, fileSize, fileType,
          }).returning();

          // Update last_message_at
          await db.update(dmConversations)
            .set({ lastMessageAt: new Date() })
            .where(eq(dmConversations.id, conversationId));

          const userInfo = await getUserInfo(user.sub);
          broadcastToRoom(`dm:${conversationId}`, 'chat:dm', {
            conversationId,
            message: {
              ...row,
              senderFirstName: userInfo.name.split(' ')[0],
              senderLastName: userInfo.name.split(' ').slice(1).join(' '),
            },
          });
        } catch (err: any) {
          logger.error({ err: err.message }, 'Failed to persist DM message');
        }
        break;
      }

      case 'chat:typing':
      case 'chat:typing_start': {
        const { channelId, conversationId } = msg.data as { channelId?: string; conversationId?: string };
        if (channelId) {
          broadcastToRoom(`chat:${channelId}`, 'chat:typing', {
            channelId, userId: user.sub, typing: true,
          });
        } else if (conversationId) {
          broadcastToRoom(`dm:${conversationId}`, 'dm:typing', {
            conversationId, userId: user.sub, typing: true,
          });
        }
        break;
      }

      case 'chat:typing_stop': {
        const { channelId, conversationId } = msg.data as { channelId?: string; conversationId?: string };
        if (channelId) {
          broadcastToRoom(`chat:${channelId}`, 'chat:typing', {
            channelId, userId: user.sub, typing: false,
          });
        } else if (conversationId) {
          broadcastToRoom(`dm:${conversationId}`, 'dm:typing', {
            conversationId, userId: user.sub, typing: false,
          });
        }
        break;
      }

      case 'chat:read': {
        const { channelId, conversationId } = msg.data as { channelId?: string; conversationId?: string };
        try {
          if (channelId) {
            await db.insert(chatReadMarkers).values({
              userId: user.sub, channelId, lastReadAt: new Date(),
            }).onConflictDoUpdate({
              target: [chatReadMarkers.userId, chatReadMarkers.channelId],
              set: { lastReadAt: new Date() },
            });
          } else if (conversationId) {
            await db.insert(chatReadMarkers).values({
              userId: user.sub, conversationId, lastReadAt: new Date(),
            }).onConflictDoUpdate({
              target: [chatReadMarkers.userId, chatReadMarkers.conversationId],
              set: { lastReadAt: new Date() },
            });
          }
        } catch (err: any) {
          logger.error({ err: err.message }, 'Failed to update read marker');
        }
        break;
      }

      case 'supervisor:join_team': {
        const { teamId } = msg.data as { teamId: string };
        break;
      }

      // ── WebRTC Signaling ──────────────────────────────────────────────
      case 'call:offer': {
        const { targetExt, sdp, callerId: customCallerId } = msg.data as { targetExt: string; sdp: string; callerId?: string };
        const callerInfo = await getUserInfo(user.sub);
        const effectiveCallerId = customCallerId || callerInfo.ext || user.sub;
        const callerDisplay = `${callerInfo.name}${callerInfo.ext ? ` (${callerInfo.ext})` : ''}`;
        logger.info({ from: user.sub, callerDisplay, targetExt, callerId: effectiveCallerId }, 'Call offer received');

        // Look up target agent name for callee display
        const targetInfo = await (async () => {
          // Find user by sipUsername = targetExt
          const [target] = await db.select({ id: users.id, firstName: users.firstName, lastName: users.lastName, sipUsername: users.sipUsername })
            .from(users).where(eq(users.sipUsername, targetExt));
          return target ? { id: target.id, name: `${target.firstName ?? ''} ${target.lastName ?? ''}`.trim(), ext: target.sipUsername ?? '' } : null;
        })();

        const offerData = {
          from: user.sub,
          fromName: callerDisplay,
          fromExt: callerInfo.ext,
          targetExt,
          targetName: targetInfo ? `${targetInfo.name} (${targetInfo.ext})` : targetExt,
          sdp,
        };

        // Check if target is an internal extension or external number
        const isExternal = /^\+?\d{7,}$/.test(targetExt) && !targetInfo;

        // Create call record first so we can link it to FreeSWITCH
        let callRow: { id: string } | null = null;
        if (user.tenantId) {
          try {
            const [row] = await db.insert(calls).values({
              tenantId: user.tenantId,
              direction: 'outbound',
              callerId: effectiveCallerId,
              callerName: callerInfo.name,
              calleeNumber: targetExt,
              calleeName: targetInfo?.name ?? targetExt,
              agentId: user.sub,
              status: 'ringing',
              startedAt: new Date(),
            }).returning({ id: calls.id });
            callRow = row ?? null;
            // Track active call in Redis
            if (callRow) {
              await setCallState(callRow.id, {
                tenantId: user.tenantId, callerId: effectiveCallerId, callerName: callerInfo.name,
                calleeNumber: targetExt, calleeName: targetInfo?.name ?? targetExt,
                agentId: user.sub, status: 'ringing', startedAt: Date.now(),
              });
            }
          } catch (e: any) { logger.error({ err: e.message, stack: e.stack }, 'Failed to create call record'); }
        }

        if (isExternal) {
          // External call — route through FreeSWITCH
          logger.info({ targetExt, caller: callerInfo.ext, callId: callRow?.id }, 'External call — routing via FreeSWITCH');
          try {
            const { eslClient } = await import('../esl/client');
            if (eslClient.isConnected()) {
              const safeName = (callerInfo.name || 'TreePBX').replace(/[^a-zA-Z0-9 _-]/g, '');
              const vars = [
                `origination_caller_id_number=${effectiveCallerId}`,
                `origination_caller_id_name='${safeName}'`,
                `originate_timeout=30`,
                ...(callRow ? [`treepbx_call_id=${callRow.id}`] : []),
                ...(user.tenantId ? [`treepbx_tenant_id=${user.tenantId}`] : []),
                `treepbx_agent_id=${user.sub}`,
              ].join(',');
              const agentBridgeExt = callerInfo.ext || user.sub;
              // Build failover dial string with all outbound gateways
              const { getOutboundGateways } = await import('../esl/commands');
              const outGateways = await getOutboundGateways();
              const dialStr = outGateways.map(gw => `sofia/gateway/${gw}/${targetExt}`).join('|');
              const cmd = `originate {${vars}}${dialStr} &bridge(user/${agentBridgeExt})`;
              logger.info({ cmd, gateways: outGateways }, 'ESL originate command');
              eslClient.bgapi(cmd);
              ws.send(JSON.stringify({ event: 'call:ringing', data: { target: targetExt } }));
            } else {
              ws.send(JSON.stringify({ event: 'call:error', data: { message: 'FreeSWITCH not connected — cannot place external calls' } }));
              // Mark call as failed
              if (callRow) {
                await db.update(calls).set({ status: 'failed', endedAt: new Date(), hangupCause: 'FREESWITCH_UNAVAILABLE' }).where(eq(calls.id, callRow.id));
              }
            }
          } catch (err: any) {
            ws.send(JSON.stringify({ event: 'call:error', data: { message: `External call failed: ${err.message}` } }));
          }
        } else {
          // Internal call — WebRTC peer-to-peer
          const sent = sendToAgent(targetExt, 'call:offer', offerData, user.sub);
          logger.info({ targetExt, directSent: sent, callerSub: user.sub, callerExt: callerInfo.ext }, 'Call offer routed');

          if (!sent) {
            ws.send(JSON.stringify({ event: 'call:error', data: { message: `Extension ${targetExt} is not online` } }));
          }
        }
        break;
      }

      case 'call:answer': {
        const { targetId, sdp } = msg.data as { targetId: string; sdp: string };
        sendToAgent(targetId, 'call:answer', { from: user.sub, sdp });
        break;
      }

      case 'call:sdp_offer': {
        const { targetId, sdp } = msg.data as { targetId: string; sdp: string };
        logger.info({ from: user.sub, targetId }, 'SDP offer sent');
        sendToAgent(targetId, 'call:sdp_offer', { from: user.sub, sdp }, user.sub);
        // Create inbound call record for the callee (answerer)
        if (user.tenantId) {
          try {
            const calleeInfo = await getUserInfo(user.sub);
            const callerInfo2 = await getUserInfo(targetId);
            await db.insert(calls).values({
              tenantId: user.tenantId,
              direction: 'inbound',
              callerId: callerInfo2.ext || targetId,
              callerName: callerInfo2.name,
              calleeNumber: calleeInfo.ext || user.sub,
              calleeName: calleeInfo.name,
              agentId: user.sub,
              status: 'answered',
              startedAt: new Date(),
              answeredAt: new Date(),
            });
          } catch { /* ignore duplicate */ }
        }
        break;
      }

      case 'call:sdp_answer': {
        const { targetId, sdp } = msg.data as { targetId: string; sdp: string };
        logger.info({ from: user.sub, targetId }, 'SDP answer sent');
        sendToAgent(targetId, 'call:sdp_answer', { from: user.sub, sdp }, user.sub);
        // Update call record to answered
        if (user.tenantId) {
          const { and: andOp, inArray } = await import('drizzle-orm');
          try {
            await db.update(calls)
              .set({ status: 'answered', answeredAt: new Date() })
              .where(andOp(eq(calls.tenantId, user.tenantId), eq(calls.status, 'ringing'), inArray(calls.agentId, [user.sub, targetId])));
          } catch { /* ignore */ }
        }
        break;
      }

      case 'call:ice_candidate': {
        const { targetId, candidate } = msg.data as { targetId: string; candidate: unknown };
        sendToAgent(targetId, 'call:ice_candidate', {
          from: user.sub,
          candidate,
        }, user.sub);
        break;
      }

      case 'call:hangup': {
        const { targetId } = msg.data as { targetId: string };
        sendToAgent(targetId, 'call:hangup', { from: user.sub }, user.sub);
        // Complete call record
        if (user.tenantId) {
          const { and: andOp, inArray, sql } = await import('drizzle-orm');
          try {
            await db.update(calls)
              .set({
                status: 'completed',
                endedAt: new Date(),
                hangupCause: 'NORMAL_CLEARING',
                durationSeconds: sql`EXTRACT(EPOCH FROM (NOW() - ${calls.startedAt}))::int`,
                talkTimeSeconds: sql`CASE WHEN ${calls.answeredAt} IS NOT NULL THEN EXTRACT(EPOCH FROM (NOW() - ${calls.answeredAt}))::int ELSE 0 END`,
              })
              .where(andOp(eq(calls.tenantId, user.tenantId), inArray(calls.status, ['ringing', 'answered']), inArray(calls.agentId, [user.sub, targetId])));
          } catch { /* ignore */ }
          // Set agent back to available
          await db.update(users).set({ status: 'available', statusChangedAt: new Date() }).where(eq(users.id, user.sub));
          // Remove active call from Redis
          const keys = await redis.keys('treepbx:call:*');
          for (const k of keys) {
            const val = await redis.get(k);
            if (val) { try { const c = JSON.parse(val); if (c.agentId === user.sub || c.agentId === targetId) await redis.del(k); } catch {} }
          }
        }
        break;
      }

      case 'call:reject': {
        const { targetId } = msg.data as { targetId: string };
        sendToAgent(targetId, 'call:reject', { from: user.sub }, user.sub);
        // Mark call as missed
        if (user.tenantId) {
          const { and: andOp, inArray } = await import('drizzle-orm');
          try {
            await db.update(calls)
              .set({ status: 'missed', endedAt: new Date() })
              .where(andOp(eq(calls.tenantId, user.tenantId), eq(calls.status, 'ringing'), inArray(calls.agentId, [user.sub, targetId])));
          } catch { /* ignore */ }
        }
        break;
      }

      // Register extension → agent mapping
      case 'agent:register_ext': {
        const { ext } = msg.data as { ext: string };
        // Join a room by extension name for direct dialing
        const { joinRoom } = require('./rooms');
        joinRoom(ws, `agent:${ext}`);
        logger.info({ userId: user.sub, ext }, 'Agent registered extension');
        break;
      }

      case 'ping': {
        ws.send(JSON.stringify({ event: 'pong', data: {} }));
        break;
      }

      default:
        logger.debug({ event: msg.event }, 'Unknown WS event');
    }
  } catch (err) {
    logger.warn({ err }, 'Invalid WS message');
  }
}
