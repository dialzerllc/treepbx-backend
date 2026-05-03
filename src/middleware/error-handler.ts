import type { ErrorHandler } from 'hono';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors';
import { logger } from '../lib/logger';
import { db } from '../db/client';
import { errorLog } from '../db/schema';

export const errorHandler: ErrorHandler = (err, c) => {
  if (err instanceof ZodError) {
    // Validation rejections are useful to debug — capture as 'warn' so the
    // debugger surfaces them. Stash the field-level details in `context`
    // because the message alone ("Validation error") doesn't say what broke.
    void recordError(c, err, 'warn', 400, {
      details: err.errors.map((e) => ({ path: e.path.join('.'), message: e.message })),
    });
    return c.json({
      error: 'Validation error',
      details: err.errors.map((e) => ({
        path: e.path.join('.'),
        message: e.message,
      })),
    }, 400);
  }

  if (err instanceof AppError) {
    // 5xx are real server problems → 'error'. 4xx are expected control flow
    // (Unauthorized, NotFound, BadRequest) → 'warn' so the debugger still
    // shows them when investigating a UI failure, filterable by level.
    void recordError(c, err, err.statusCode >= 500 ? 'error' : 'warn', err.statusCode);
    return c.json({ error: err.message, code: err.code }, err.statusCode as any);
  }

  logger.error({ err }, 'Unhandled error');
  void recordError(c, err, 'error', 500);
  return c.json({ error: 'Internal server error' }, 500);
};

// Best-effort persistence: never let logging-the-error-fail throw and mask the
// original error response.
async function recordError(c: any, err: any, level: 'error' | 'warn', status: number, extra?: Record<string, unknown>): Promise<void> {
  try {
    const userId = c.get('userId') ?? null;
    const tenantId = c.get('tenantId') ?? null;
    await db.insert(errorLog).values({
      level,
      source: 'server',
      method: c.req.method,
      path: c.req.path,
      statusCode: status,
      userId,
      tenantId,
      errType: err?.constructor?.name ?? typeof err,
      errMessage: err?.message ?? String(err),
      stack: err?.stack ?? null,
      context: { requestId: c.get('requestId') ?? null, ...(extra ?? {}) },
    });
  } catch (logErr) {
    logger.warn({ logErr }, '[error-handler] failed to persist error');
  }
}
