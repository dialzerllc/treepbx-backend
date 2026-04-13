import type { Job } from 'bullmq';
import { logger } from '../lib/logger';

interface CrmSyncJob {
  integrationId: string;
  tenantId: string;
  provider: string;
  direction: string;
}

export async function processCrmSync(job: Job<CrmSyncJob>) {
  const { integrationId, provider, direction } = job.data;
  logger.info({ integrationId, provider, direction }, 'Starting CRM sync');

  // TODO: Use CRM adapter based on provider
  // 1. Fetch contacts from CRM
  // 2. Upsert into leads table
  // 3. Push call records to CRM
  // 4. Update last_sync_at

  logger.info({ integrationId }, 'CRM sync complete (stub)');
}
