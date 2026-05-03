import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../env';

// MinIO is S3-compatible, use AWS SDK
export const s3Client = new S3Client({
  endpoint: `http://${env.MINIO_ENDPOINT}:${env.MINIO_PORT}`,
  region: 'us-east-1',
  credentials: {
    accessKeyId: env.MINIO_ACCESS_KEY,
    secretAccessKey: env.MINIO_SECRET_KEY,
  },
  forcePathStyle: true,
});

const BUCKET = env.MINIO_BUCKET;

export async function uploadFile(key: string, body: Buffer | Uint8Array, contentType: string): Promise<string> {
  await s3Client.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: contentType }));
  return key;
}

export async function getFileUrl(key: string, expiresIn = 3600): Promise<string> {
  const url = await getSignedUrl(s3Client, new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn });
  return url;
}

export async function getFileBuffer(key: string): Promise<Buffer> {
  const res = await s3Client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  if (!res.Body) throw new Error(`MinIO object missing body: ${key}`);
  // @ts-ignore - Body is a Readable | Blob | ReadableStream depending on runtime
  const arrayBuf = await (res.Body as any).transformToByteArray();
  return Buffer.from(arrayBuf);
}

// Keep old name as alias for backward compatibility
export const getPresignedUrl = getFileUrl;

export async function deleteFile(key: string): Promise<void> {
  await s3Client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

export async function uploadRecording(tenantId: string, callId: string, audioBuffer: Buffer, format = 'wav'): Promise<string> {
  const key = `recordings/${tenantId}/${callId}.${format}`;
  await uploadFile(key, audioBuffer, `audio/${format}`);
  return key;
}

export async function uploadCSV(tenantId: string, fileName: string, csvBuffer: Buffer): Promise<string> {
  const key = `imports/${tenantId}/${Date.now()}-${fileName}`;
  await uploadFile(key, csvBuffer, 'text/csv');
  return key;
}

export async function uploadLogo(tenantId: string, imageBuffer: Buffer, ext = 'png'): Promise<string> {
  const key = `logos/${tenantId}/logo.${ext}`;
  await uploadFile(key, imageBuffer, `image/${ext}`);
  return key;
}
