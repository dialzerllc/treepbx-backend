import { verifyToken, type JWTPayload } from '../lib/jwt';
import { redis } from '../lib/redis';

export async function authenticateWs(url: string): Promise<JWTPayload | null> {
  try {
    const params = new URL(url, 'http://localhost').searchParams;

    // Preferred: single-use ticket exchanged via POST /auth/ws-ticket.
    // Keeps the JWT off the URL (which gets logged by Caddy/proxies).
    const ticket = params.get('ticket');
    if (ticket && /^[a-f0-9]{64}$/.test(ticket)) {
      // Atomic single-use consumption via MULTI/EXEC (compatible with Redis < 6.2,
      // which lacks GETDEL). GET + DEL inside a transaction means concurrent
      // consumers see the same value but only one actually consumes it.
      const key = `treepbx:wsticket:${ticket}`;
      const result = await redis.multi().get(key).del(key).exec();
      const raw = result?.[0]?.[1] as string | null | undefined;
      if (!raw) return null;
      try {
        return JSON.parse(raw) as JWTPayload;
      } catch {
        return null;
      }
    }

    return null;
  } catch {
    return null;
  }
}
