import { eslClient } from './client';
import { db } from '../db/client';
import { calls } from '../db/schema';
import { eq } from 'drizzle-orm';
import { publishCallRinging, publishCallEnded, publishAgentStatus } from '../ws/publisher';
import { logger } from '../lib/logger';

export function startESLEventListener() {
  eslClient.on('event', async (headers: Record<string, string>) => {
    const eventName = headers['Event-Name'];
    const uuid = headers['Unique-ID'];

    try {
      switch (eventName) {
        case 'CHANNEL_CREATE': {
          logger.debug({ uuid, caller: headers['Caller-Caller-ID-Number'] }, 'Channel created');
          break;
        }

        case 'CHANNEL_ANSWER': {
          if (uuid) {
            await db.update(calls).set({
              status: 'answered',
              answeredAt: new Date(),
            }).where(eq(calls.freeswitchUuid, uuid));
          }
          break;
        }

        case 'CHANNEL_HANGUP': {
          if (uuid) {
            const hangupCause = headers['Hangup-Cause'] ?? 'NORMAL_CLEARING';
            const duration = parseInt(headers['variable_duration'] ?? '0');
            const billSec = parseInt(headers['variable_billsec'] ?? '0');

            await db.update(calls).set({
              status: 'completed',
              endedAt: new Date(),
              durationSeconds: duration,
              talkTimeSeconds: billSec,
              hangupCause,
            }).where(eq(calls.freeswitchUuid, uuid));

            // Get the call to find tenant/agent for WS events
            const [call] = await db.select().from(calls)
              .where(eq(calls.freeswitchUuid, uuid)).limit(1);

            if (call) {
              publishCallEnded(call.tenantId, call.agentId ?? '', {
                callId: call.id,
                duration,
                hangupCause,
              });

              if (call.agentId) {
                publishAgentStatus(call.tenantId, call.agentId, 'wrap_up');
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
          // TODO: Enqueue recording-upload worker job
          break;
        }
      }
    } catch (err) {
      logger.error({ eventName, uuid, err }, 'ESL event handler error');
    }
  });

  logger.info('ESL event listener started');
}
