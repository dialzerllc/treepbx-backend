import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string(),
  MINIO_ENDPOINT: z.string().default('localhost'),
  MINIO_PORT: z.coerce.number().default(9000),
  MINIO_ACCESS_KEY: z.string().default('treepbx'),
  MINIO_SECRET_KEY: z.string().default('treepbx_dev'),
  MINIO_BUCKET: z.string().default('treepbx'),
  MINIO_REGION: z.string().default('us-east-1'),
  MINIO_FORCE_PATH_STYLE: z.string().default('true'),
  MINIO_PUBLIC_URL: z.string().optional(),
  JWT_PRIVATE_KEY_PATH: z.string().default('./keys/private.pem'),
  JWT_PUBLIC_KEY_PATH: z.string().default('./keys/public.pem'),
  JWT_ACCESS_TTL: z.coerce.number().default(900),
  JWT_REFRESH_TTL: z.coerce.number().default(2592000),
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  // GPU server endpoints — used by ai-screen mode for STT/TTS/LLM verdicts.
  // All optional so the backend still boots if the GPU box is offline; the
  // ai-screen feature itself just becomes unavailable (campaigns can still
  // be saved, but live calls error out fast at originate time).
  GPU_STT_URL: z.string().url().optional(),
  GPU_TTS_URL: z.string().url().optional(),
  GPU_LLM_URL: z.string().url().optional(),
  GPU_LLM_MODEL: z.string().default('llama3:latest'),
});

export const env = envSchema.parse(process.env);
export type Env = z.infer<typeof envSchema>;
