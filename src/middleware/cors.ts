import { cors } from 'hono/cors';
import { env } from '../env';

export const corsMiddleware = cors({
  origin: env.NODE_ENV === 'production' ? env.CORS_ORIGIN : '*',
  credentials: true,
  allowHeaders: ['Content-Type', 'Authorization'],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  maxAge: 86400,
});
