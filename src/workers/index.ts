import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { env } from '../env';
import { logger } from '../lib/logger';
import { processTranscription } from './transcription.worker';
import { processAiSummary } from './ai-summary.worker';
import { processBilling } from './billing.worker';
import { processRecordingUpload } from './recording-upload.worker';
import { processCsvImport } from './csv-import.worker';
import { processCsvExport } from './csv-export.worker';
import { processFraudScan } from './fraud-scan.worker';
import { processWebhookDelivery } from './webhook-delivery.worker';
import { processCrmSync } from './crm-sync.worker';
import { processKbIndexer } from './kb-indexer.worker';

const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });

const workers: Worker[] = [];

export function startWorkers() {
  const queues: [string, (job: any) => Promise<void>][] = [
    ['transcription', processTranscription],
    ['ai-summary', processAiSummary],
    ['billing', processBilling],
    ['recording-upload', processRecordingUpload],
    ['csv-import', processCsvImport],
    ['csv-export', processCsvExport],
    ['fraud-scan', processFraudScan],
    ['webhook-delivery', processWebhookDelivery],
    ['crm-sync', processCrmSync],
    ['kb-indexer', processKbIndexer],
  ];

  for (const [name, processor] of queues) {
    const worker = new Worker(name, processor, {
      connection,
      concurrency: 5,
    });

    worker.on('completed', (job) => {
      logger.debug({ queue: name, jobId: job.id }, 'Job completed');
    });

    worker.on('failed', (job, err) => {
      logger.error({ queue: name, jobId: job?.id, err }, 'Job failed');
    });

    workers.push(worker);
    logger.info({ queue: name }, 'Worker started');
  }
}

export async function stopWorkers() {
  await Promise.all(workers.map((w) => w.close()));
}
