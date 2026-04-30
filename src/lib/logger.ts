import pino, { multistream } from 'pino';
import { Writable } from 'stream';
import { env } from '../env';

/**
 * Log buffer: a ring of the last MAX_BUFFER pino entries, populated by tapping
 * the logger via multistream. Powers the /platform/autoscaler/logs endpoint.
 *
 * Trade-off: switching from pino's `transport: pino-pretty` to multistream
 * means dev logs land as JSON in journalctl. Pipe through `pino-pretty` if
 * you want colour locally. The win is a structured in-process buffer the Logs
 * tab can poll without going through journald.
 */
export interface BufferedLog {
  time: number;
  level: number;        // pino numeric level (10/20/30/40/50/60)
  msg: string;
  data?: Record<string, unknown>;
}

const MAX_BUFFER = 500;
const buffer: BufferedLog[] = [];

const memoryStream = new Writable({
  write(chunk, _enc, cb) {
    try {
      const entry = JSON.parse(chunk.toString());
      const { time, level, msg, ...rest } = entry;
      // Drop pino's own metadata so `data` only contains user-supplied fields.
      delete rest.pid;
      delete rest.hostname;
      buffer.push({
        time: Number(time),
        level: Number(level),
        msg: typeof msg === 'string' ? msg : '',
        data: Object.keys(rest).length ? rest : undefined,
      });
      while (buffer.length > MAX_BUFFER) buffer.shift();
    } catch {
      // Bad JSON — skip silently rather than recursing into the logger.
    }
    cb();
  },
});

export const logger = pino(
  { level: env.NODE_ENV === 'production' ? 'info' : 'debug' },
  multistream([
    { stream: process.stdout },
    { stream: memoryStream },
  ]),
);

const LEVEL_CUTOFF: Record<string, number> = {
  trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60,
};

export function getRecentLogs(opts: { since?: number; level?: string; limit?: number; search?: string } = {}): BufferedLog[] {
  let result = buffer;
  if (opts.since != null) result = result.filter((e) => e.time > opts.since!);
  if (opts.level) {
    const cutoff = LEVEL_CUTOFF[opts.level] ?? 0;
    if (cutoff > 0) result = result.filter((e) => e.level >= cutoff);
  }
  if (opts.search) {
    const q = opts.search.toLowerCase();
    result = result.filter((e) =>
      e.msg.toLowerCase().includes(q) ||
      (e.data ? JSON.stringify(e.data).toLowerCase().includes(q) : false)
    );
  }
  if (opts.limit) result = result.slice(-opts.limit);
  return result;
}
