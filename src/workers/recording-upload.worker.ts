import type { Job } from 'bullmq';
import { logger } from '../lib/logger';

interface RecordingUploadJob {
  callId: string;
  tenantId: string;
  localPath: string;
}

export async function processRecordingUpload(job: Job<RecordingUploadJob>) {
  const { callId, localPath } = job.data;
  logger.info({ callId }, 'Uploading recording to MinIO');

  // TODO: Read file from FreeSWITCH NFS mount, upload to MinIO
  // const minioKey = `recordings/${tenantId}/${callId}.wav`;
  // await minioClient.putObject(bucket, minioKey, file);
  // Insert call_recordings record

  logger.info({ callId }, 'Recording upload complete (stub)');
}
