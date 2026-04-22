import { verifyToken, type JWTPayload } from '../lib/jwt';
import { redis } from '../lib/redis';

export async function authenticateWs(url: string): Promise<JWTPayload | null> {
  try {
    const params = new URL(url, 'http://localhost').searchParams;

    // Preferred: single-use ticket exchanged via POST /auth/ws-ticket.
    // Keeps the JWT off the URL (which gets logged by Caddy/proxies).
    const ticket = params.get('ticket');
    if (ticket && /^[a-f0-9]{64}$/.test(ticket)) {
      // GETDEL is atomic — ticket can only be consumed once.
      const raw = await (redis as any).getdel(`treepbx:wsticket:${ticket}`);
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
