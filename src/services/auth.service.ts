import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { users, refreshTokens } from '../db/schema';
import { hashPassword, verifyPassword } from '../lib/password';
import { signAccessToken, signRefreshToken, type JWTPayload } from '../lib/jwt';
import { Unauthorized, NotFound } from '../lib/errors';
import { nanoid } from 'nanoid';

export async function login(email: string, password: string) {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (!user) throw new Unauthorized('Invalid email or password');
  if (user.deletedAt) throw new Unauthorized('Account is disabled');

  const valid = await verifyPassword(user.passwordHash, password);
  if (!valid) throw new Unauthorized('Invalid email or password');

  // Update last login
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));

  const jwtPayload: JWTPayload = {
    sub: user.id,
    role: user.role,
    tenantId: user.tenantId ?? undefined,
    email: user.email,
    permissions: (user.permissions as JWTPayload['permissions']) ?? {},
  };

  const accessToken = await signAccessToken(jwtPayload);
  const refreshToken = await signRefreshToken(user.id);

  // Store refresh token hash (use SHA-256 for uniqueness)
  const encoder = new TextEncoder();
  const hashBuf = await crypto.subtle.digest('SHA-256', encoder.encode(refreshToken));
  const tokenHash = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
  await db.insert(refreshTokens).values({
    userId: user.id,
    tokenHash,
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  });

  return {
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      tenantId: user.tenantId,
      permissions: user.permissions,
      settings: user.settings,
    },
    token: accessToken,
    refreshToken,
  };
}

export async function getMe(userId: string) {
  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      role: users.role,
      tenantId: users.tenantId,
      permissions: users.permissions,
      settings: users.settings,
      status: users.status,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) throw new NotFound('User not found');
  return user;
}

export async function logout(userId: string) {
  // Revoke all refresh tokens for user
  await db.delete(refreshTokens).where(eq(refreshTokens.userId, userId));
}
