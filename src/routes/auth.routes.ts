import { Hono } from 'hono';
import { z } from 'zod';
import * as authService from '../services/auth.service';
import { authMiddleware } from '../middleware/auth';
import { loginEmail } from '../lib/zod-helpers';

const auth = new Hono();

const loginSchema = z.object({
  email: loginEmail(),
  password: z.string().min(1),
  totpCode: z.string().regex(/^\d{6}$/).optional(),
});

auth.post('/login', async (c) => {
  const body = loginSchema.parse(await c.req.json());

  // Rate limit: 10 attempts per email per 5 minutes
  const { checkRateLimit } = await import('../lib/redis');
  const { allowed, remaining } = await checkRateLimit(`login:${body.email}`, 10, 300);
  if (!allowed) {
    c.header('Retry-After', '300');
    return c.json({ error: 'Too many login attempts. Try again in 5 minutes.' }, 429);
  }

  const result = await authService.login(body.email, body.password, body.totpCode);
  c.header('X-RateLimit-Remaining', String(remaining));
  // 2FA challenge response — frontend should prompt for the code and POST again with totpCode
  if ('requires2FA' in result) return c.json(result, 200);
  return c.json(result);
});

auth.post('/logout', authMiddleware, async (c) => {
  const user = c.get('user');
  await authService.logout(user.sub);

  // Blacklist the access token in Redis (TTL = token expiry)
  try {
    const { redis } = await import('../lib/redis');
    const header = c.req.header('Authorization');
    const token = header?.startsWith('Bearer ') ? header.slice(7) : '';
    if (token) {
      await redis.set(`treepbx:blacklist:${token.slice(-16)}`, '1', 'EX', 86400);
    }
  } catch { /* Redis down — token will expire naturally */ }

  return c.json({ ok: true });
});

auth.post('/refresh', async (c) => {
  const body = z.object({ refreshToken: z.string().min(1) }).parse(await c.req.json());
  const { db } = await import('../db/client');
  const { users, refreshTokens } = await import('../db/schema');
  const { eq } = await import('drizzle-orm');
  const { verifyToken, signAccessToken, signRefreshToken } = await import('../lib/jwt');

  // Verify the refresh token JWT
  let payload;
  try {
    payload = await verifyToken(body.refreshToken);
  } catch {
    return c.json({ error: 'Invalid or expired refresh token' }, 401);
  }

  // Check refresh token hash exists in DB
  const encoder = new TextEncoder();
  const hashBuf = await crypto.subtle.digest('SHA-256', encoder.encode(body.refreshToken));
  const tokenHash = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');

  const [stored] = await db.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, tokenHash)).limit(1);
  if (!stored || stored.expiresAt < new Date()) {
    return c.json({ error: 'Refresh token revoked or expired' }, 401);
  }

  // Get user
  const [user] = await db.select().from(users).where(eq(users.id, payload.sub)).limit(1);
  if (!user || user.deletedAt) {
    return c.json({ error: 'User not found' }, 401);
  }

  // Issue new access token
  const jwtPayload = {
    sub: user.id,
    role: user.role,
    tenantId: user.tenantId ?? undefined,
    email: user.email,
    permissions: (user.permissions as any) ?? {},
  };
  const accessToken = await signAccessToken(jwtPayload);

  // Rotate refresh token
  await db.delete(refreshTokens).where(eq(refreshTokens.tokenHash, tokenHash));
  const newRefreshToken = await signRefreshToken(user.id);
  const newHashBuf = await crypto.subtle.digest('SHA-256', encoder.encode(newRefreshToken));
  const newTokenHash = Array.from(new Uint8Array(newHashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
  await db.insert(refreshTokens).values({
    userId: user.id,
    tokenHash: newTokenHash,
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  });

  return c.json({ token: accessToken, refreshToken: newRefreshToken });
});

auth.get('/me', authMiddleware, async (c) => {
  // Rate limit per user: 120/min. Protects DB from a stuck-client poll loop.
  const { checkRateLimit } = await import('../lib/redis');
  const user = c.get('user');
  const { allowed } = await checkRateLimit(`me:${user.sub}`, 120, 60);
  if (!allowed) {
    c.header('Retry-After', '60');
    return c.json({ error: 'Too many requests' }, 429);
  }
  const profile = await authService.getMe(user.sub);
  return c.json(profile);
});

// Short-lived ticket exchange for WebSocket auth. Keeps JWT out of URL query strings
// (which Caddy / proxies log). Ticket is single-use and expires in 30 seconds.
auth.post('/ws-ticket', authMiddleware, async (c) => {
  const { redis } = await import('../lib/redis');
  const user = c.get('user');
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  const ticket = Array.from(buf).map((b) => b.toString(16).padStart(2, '0')).join('');
  const payload = JSON.stringify({
    sub: user.sub,
    role: user.role,
    tenantId: user.tenantId ?? null,
    email: user.email,
    permissions: user.permissions ?? {},
  });
  await redis.set(`treepbx:wsticket:${ticket}`, payload, 'EX', 30);
  return c.json({ ticket });
});

/**
 * 2FA setup flow:
 *   POST /auth/2fa/setup    → returns { secret, otpauthUrl }; secret is staged on the user row
 *                              but `totp_enabled` stays false until /verify confirms a code.
 *   POST /auth/2fa/verify   → { code } — flips totp_enabled true on success.
 *   POST /auth/2fa/disable  → { code } — verifies a current code, then clears the secret.
 */
auth.post('/2fa/setup', authMiddleware, async (c) => {
  const { db } = await import('../db/client');
  const { users } = await import('../db/schema');
  const { eq } = await import('drizzle-orm');
  const { generateBase32Secret, buildOtpauthUrl } = await import('../lib/totp');
  const u = c.get('user');
  const secret = generateBase32Secret();
  await db.update(users).set({ totpSecret: secret, totpEnabled: false }).where(eq(users.id, u.sub));
  const otpauthUrl = buildOtpauthUrl({ issuer: 'TreePBX', accountName: u.email, secret });
  return c.json({ secret, otpauthUrl });
});

auth.post('/2fa/verify', authMiddleware, async (c) => {
  const { db } = await import('../db/client');
  const { users } = await import('../db/schema');
  const { eq } = await import('drizzle-orm');
  const { verifyTotp } = await import('../lib/totp');
  const body = z.object({ code: z.string().regex(/^\d{6}$/) }).parse(await c.req.json());
  const u = c.get('user');
  const [row] = await db.select({ totpSecret: users.totpSecret }).from(users).where(eq(users.id, u.sub));
  if (!row?.totpSecret) return c.json({ error: 'No pending 2FA setup. POST /2fa/setup first.' }, 400);
  if (!verifyTotp(row.totpSecret, body.code)) return c.json({ error: 'Invalid code' }, 400);
  await db.update(users).set({ totpEnabled: true }).where(eq(users.id, u.sub));
  return c.json({ ok: true, enabled: true });
});

auth.post('/2fa/disable', authMiddleware, async (c) => {
  const { db } = await import('../db/client');
  const { users } = await import('../db/schema');
  const { eq } = await import('drizzle-orm');
  const { verifyTotp } = await import('../lib/totp');
  const body = z.object({ code: z.string().regex(/^\d{6}$/) }).parse(await c.req.json());
  const u = c.get('user');
  const [row] = await db.select({ totpSecret: users.totpSecret, totpEnabled: users.totpEnabled }).from(users).where(eq(users.id, u.sub));
  if (!row?.totpEnabled || !row.totpSecret) return c.json({ error: '2FA not currently enabled' }, 400);
  if (!verifyTotp(row.totpSecret, body.code)) return c.json({ error: 'Invalid code' }, 400);
  await db.update(users).set({ totpSecret: null, totpEnabled: false }).where(eq(users.id, u.sub));
  return c.json({ ok: true, enabled: false });
});

auth.get('/2fa/status', authMiddleware, async (c) => {
  const { db } = await import('../db/client');
  const { users } = await import('../db/schema');
  const { eq } = await import('drizzle-orm');
  const u = c.get('user');
  const [row] = await db.select({ totpEnabled: users.totpEnabled }).from(users).where(eq(users.id, u.sub));
  return c.json({ enabled: !!row?.totpEnabled });
});

auth.put('/me', authMiddleware, async (c) => {
  const { db } = await import('../db/client');
  const { users } = await import('../db/schema');
  const { eq } = await import('drizzle-orm');
  const updateSchema = z.object({
    firstName: z.string().min(1).optional(),
    lastName: z.string().min(1).optional(),
    timezone: z.string().optional(),
    settings: z.record(z.unknown()).optional(),
  });
  const user = c.get('user');
  const body = updateSchema.parse(await c.req.json());
  const [row] = await db.update(users)
    .set({ ...body, updatedAt: new Date() })
    .where(eq(users.id, user.sub))
    .returning({
      id: users.id,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      role: users.role,
      settings: users.settings,
    });
  if (!row) return c.json({ error: 'User not found' }, 404);
  return c.json(row);
});

export default auth;
