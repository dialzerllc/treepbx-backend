import { Queue, Worker, type Job } from 'bullmq';
import { env } from '../env';

// Parse REDIS_URL to BullMQ connection params. BullMQ doesn't accept a URL directly.
function parseRedisUrl(url: string): { host: string; port: number; password?: string } {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : 6379,
    password: u.password || undefined,
  };
}

const connection = parseRedisUrl(env.REDIS_URL);

// --- Queues ---
export const csvImportQueue = new Queue('csv-import', { connection });
export const transcriptionQueue = new Queue('transcription', { connection });
export const billingQueue = new Queue('billing', { connection });
export const notificationQueue = new Queue('notification', { connection });

// --- Workers ---
export function startWorkers() {
  // CSV Import Worker
  const csvWorker = new Worker('csv-import', async (job: Job) => {
    const { tenantId, leadListId, leads } = job.data;
    const { db } = await import('../db/client');
    const { leads: leadsTable, leadLists } = await import('../db/schema');
    const { eq, count } = await import('drizzle-orm');

    let created = 0;
    let skipped = 0;
    const batchSize = 100;

    for (let i = 0; i < leads.length; i += batchSize) {
      const batch = leads.slice(i, i + batchSize);
      const values = batch.map((l: any) => ({
        tenantId,
        leadListId,
        phone: l.phone,
        firstName: l.firstName || null,
        lastName: l.lastName || null,
        email: l.email || null,
        company: l.company || null,
        timezone: l.timezone || null,
        source: 'csv_import',
        status: 'pending',
      }));
      try {
        const inserted = await db.insert(leadsTable).values(values).onConflictDoNothing().returning({ id: leadsTable.id });
        created += inserted.length;
        skipped += values.length - inserted.length;
      } catch {
        skipped += values.length;
      }
      await job.updateProgress(Math.round(((i + batch.length) / leads.length) * 100));
    }

    // Update lead count
    const [{ cnt }] = await db.select({ cnt: count() }).from(leadsTable).where(eq(leadsTable.leadListId, leadListId));
    await db.update(leadLists).set({ leadCount: Number(cnt) }).where(eq(leadLists.id, leadListId));

    return { created, skipped };
  }, { connection, concurrency: 2 });

  // Transcription Worker (placeholder)
  const transcriptionWorker = new Worker('transcription', async (job: Job) => {
    const { recordingId, audioUrl } = job.data;
    // TODO: Call Whisper API for transcription
    console.log(`[Transcription] Processing recording ${recordingId}`);
    return { status: 'pending', recordingId };
  }, { connection, concurrency: 1 });

  // Billing Worker
  const billingWorker = new Worker('billing', async (job: Job) => {
    const { tenantId, callId, durationSeconds, ratePerMinute } = job.data;
    const { db } = await import('../db/client');
    const { wallets, transactions } = await import('../db/schema');
    const { eq, sql } = await import('drizzle-orm');

    const cost = (durationSeconds / 60) * ratePerMinute;
    if (cost <= 0) return { charged: 0 };

    const result = await db.transaction(async (tx) => {
      const walletRows = await tx.execute(sql`SELECT * FROM wallets WHERE tenant_id = ${tenantId} FOR UPDATE`);
      const wallet = walletRows[0] as any;
      if (!wallet) return { charged: 0, error: 'No wallet' };

      const newBalance = Number(wallet.balance) - cost;
      await tx.update(wallets).set({ balance: String(newBalance), updatedAt: new Date() }).where(eq(wallets.id, wallet.id));
      await tx.insert(transactions).values({
        tenantId,
        walletId: wallet.id,
        type: 'debit',
        amount: String(cost),
        balanceAfter: String(newBalance),
        description: `Call charge (${durationSeconds}s)`,
        reference: callId,
      });
      return { charged: cost, newBalance };
    });

    return result;
  }, { connection, concurrency: 5 });

  // Notification Worker (placeholder)
  const notificationWorker = new Worker('notification', async (job: Job) => {
    const { type, to, message } = job.data;
    console.log(`[Notification] ${type} to ${to}: ${message}`);
    return { sent: true };
  }, { connection, concurrency: 3 });

  // Error handling
  [csvWorker, transcriptionWorker, billingWorker, notificationWorker].forEach((w) => {
    w.on('failed', (job, err) => console.error(`[Queue:${w.name}] Job ${job?.id} failed:`, err.message));
    w.on('completed', (job) => console.log(`[Queue:${w.name}] Job ${job.id} completed`));
  });

  console.log('[BullMQ] Workers started: csv-import, transcription, billing, notification');
}
