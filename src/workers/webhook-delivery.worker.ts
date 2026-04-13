import type { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { webhooks } from '../db/schema';
import { logger } from '../lib/logger';

interface WebhookDeliveryJob {
  webhookId: string;
  event: string;
  payload: unknown;
}

export async function processWebhookDelivery(job: Job<WebhookDeliveryJob>) {
  const { webhookId, event, payload } = job.data;

  const [webhook] = await db.select().from(webhooks).where(eq(webhooks.id, webhookId));
  if (!webhook || !webhook.active) return;

  const body = JSON.stringify({ event, data: payload, timestamp: new Date().toISOString() });

  // HMAC signature
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(webhook.secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  const signature = Buffer.from(sig).toString('hex');

  try {
    const response = await fetch(webhook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Signature': signature,
        'X-Event': event,
      },
      body,
      signal: AbortSignal.timeout(10000),
    });

    await db.update(webhooks).set({
      lastDeliveryAt: new Date(),
      lastDeliveryStatus: response.status,
      failureCount: response.ok ? 0 : (webhook.failureCount ?? 0) + 1,
    }).where(eq(webhooks.id, webhookId));

    if (!response.ok) {
      throw new Error(`Webhook returned ${response.status}`);
    }

    logger.info({ webhookId, event, status: response.status }, 'Webhook delivered');
  } catch (err) {
    await db.update(webhooks).set({
      failureCount: (webhook.failureCount ?? 0) + 1,
      lastDeliveryAt: new Date(),
      lastDeliveryStatus: 0,
    }).where(eq(webhooks.id, webhookId));

    // Retry up to 3 times with exponential backoff
    if ((job.attemptsMade ?? 0) < 3) throw err;
    logger.error({ webhookId, err }, 'Webhook delivery failed permanently');
  }
}
