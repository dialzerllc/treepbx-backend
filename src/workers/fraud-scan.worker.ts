import type { Job } from 'bullmq';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/client';
import { callRecordings, fraudKeywords, fraudAlerts } from '../db/schema';
import { logger } from '../lib/logger';

interface FraudScanJob {
  recordingId: string;
  tenantId: string;
  callId: string;
  agentId?: string;
}

export async function processFraudScan(job: Job<FraudScanJob>) {
  const { recordingId, tenantId, callId, agentId } = job.data;
  logger.info({ recordingId }, 'Scanning for fraud keywords');

  // Get transcript
  const [recording] = await db.select().from(callRecordings)
    .where(eq(callRecordings.id, recordingId));

  if (!recording?.transcript) {
    logger.info({ recordingId }, 'No transcript, skipping fraud scan');
    return;
  }

  // Get active keywords
  const keywords = await db.select().from(fraudKeywords)
    .where(and(eq(fraudKeywords.active, true)));

  const transcript = recording.transcript.toLowerCase();

  for (const kw of keywords) {
    const term = kw.keyword.toLowerCase();
    const found = kw.isPhrase
      ? transcript.includes(term)
      : kw.isRegex
        ? new RegExp(kw.keyword, 'i').test(transcript)
        : transcript.includes(term);

    if (found) {
      // Find context around the keyword
      const idx = transcript.indexOf(term);
      const start = Math.max(0, idx - 50);
      const end = Math.min(transcript.length, idx + term.length + 50);
      const context = transcript.slice(start, end);

      await db.insert(fraudAlerts).values({
        tenantId,
        callId,
        agentId,
        fraudKeywordId: kw.id,
        keyword: kw.keyword,
        phraseContext: context,
        severity: kw.severity ?? 'warning',
        source: 'recording',
      });

      logger.warn({ callId, keyword: kw.keyword, severity: kw.severity }, 'Fraud keyword detected');
    }
  }

  await db.update(callRecordings)
    .set({ fraudScanStatus: 'done' })
    .where(eq(callRecordings.id, recordingId));
}
