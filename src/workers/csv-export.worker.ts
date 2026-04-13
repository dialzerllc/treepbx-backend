import type { Job } from 'bullmq';
import { logger } from '../lib/logger';

interface CsvExportJob {
  type: 'cdr' | 'agents' | 'leads' | 'fraud-keywords';
  tenantId: string;
  filters: Record<string, string>;
  userId: string;
}

export async function processCsvExport(job: Job<CsvExportJob>) {
  const { type, tenantId } = job.data;
  logger.info({ type, tenantId }, 'Processing CSV export');

  // TODO: Query DB with filters, generate CSV, upload to MinIO exports/ bucket
  // Return presigned URL for download

  logger.info({ type }, 'CSV export complete (stub)');
}
