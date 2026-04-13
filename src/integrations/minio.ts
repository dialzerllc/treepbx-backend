import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../env';

export const s3Client = new S3Client({
  region: 'us-east-1',
  endpoint: `http://${env.MINIO_ENDPOINT}:${env.MINIO_PORT}`,
  forcePathStyle: true,
  credentials: {
    accessKeyId: env.MINIO_ACCESS_KEY,
    secretAccessKey: env.MINIO_SECRET_KEY,
  },
});

const bucket = env.MINIO_BUCKET;

export async function uploadFile(key: string, body: Buffer | ReadableStream, contentType: string) {
  await s3Client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
  }));
  return key;
}

export async function getPresignedUrl(key: string, expiresIn = 900) {
  return getSignedUrl(s3Client, new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  }), { expiresIn });
}

export async function deleteFile(key: string) {
  await s3Client.send(new DeleteObjectCommand({
    Bucket: bucket,
    Key: key,
  }));
}
