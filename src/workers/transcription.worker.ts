import type { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { callRecordings } from '../db/schema';
import { logger } from '../lib/logger';

interface TranscriptionJob {
  recordingId: string;
  minioKey: string;
  tenantId: string;
}

export async function processTranscription(job: Job<TranscriptionJob>) {
  const { recordingId, minioKey } = job.data;
  logger.info({ recordingId }, 'Starting transcription');

  await db.update(callRecordings)
    .set({ transcriptStatus: 'processing' })
    .where(eq(callRecordings.id, recordingId));

  try {
    // TODO: Call Whisper STT API on GPU pod
    // const transcript = await whisperClient.transcribe(minioKey);
    const transcript = '[Transcription placeholder - Whisper STT integration pending]';

    await db.update(callRecordings).set({
      transcript,
      transcriptStatus: 'done',
    }).where(eq(callRecordings.id, recordingId));

    logger.info({ recordingId }, 'Transcription complete');
  } catch (err) {
    await db.update(callRecordings)
      .set({ transcriptStatus: 'failed' })
      .where(eq(callRecordings.id, recordingId));
    throw err;
  }
}
