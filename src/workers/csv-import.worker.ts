import type { Job } from 'bullmq';
import { logger } from '../lib/logger';

interface CsvImportJob {
  type: 'leads' | 'dnc' | 'npanxx' | 'dids' | 'rates' | 'agents' | 'fraud-keywords';
  tenantId?: string;
  minioKey: string;
  userId: string;
}

export async function processCsvImport(job: Job<CsvImportJob>) {
  const { type, minioKey } = job.data;
  logger.info({ type, minioKey }, 'Processing CSV import');

  // TODO: Download CSV from MinIO, parse rows, batch insert
  // 1. Download file from MinIO
  // 2. Parse CSV with csv-parse
  // 3. Validate each row
  // 4. Batch insert (chunks of 1000)
  // 5. Update job progress
  // 6. Delete temp file from MinIO imports/ bucket

  logger.info({ type }, 'CSV import complete (stub)');
}
