import type { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { callRecordings } from '../db/schema';
import { logger } from '../lib/logger';

interface AiSummaryJob {
  recordingId: string;
  transcript: string;
}

export async function processAiSummary(job: Job<AiSummaryJob>) {
  const { recordingId, transcript } = job.data;
  logger.info({ recordingId }, 'Generating AI summary');

  await db.update(callRecordings)
    .set({ summaryStatus: 'processing' })
    .where(eq(callRecordings.id, recordingId));

  try {
    // TODO: Call Ollama LLM API on GPU pod
    // const summary = await ollamaClient.summarize(transcript);
    const summary = '[AI summary placeholder - Ollama integration pending]';

    await db.update(callRecordings).set({
      summary,
      summaryStatus: 'done',
    }).where(eq(callRecordings.id, recordingId));

    logger.info({ recordingId }, 'AI summary complete');
  } catch (err) {
    await db.update(callRecordings)
      .set({ summaryStatus: 'failed' })
      .where(eq(callRecordings.id, recordingId));
    throw err;
  }
}
