import { importPKCS8, importSPKI, SignJWT, jwtVerify } from 'jose';
import { env } from '../env';
import { readFileSync } from 'fs';

let privateKey: CryptoKey;
let publicKey: CryptoKey;

export async function initKeys() {
  const privPem = readFileSync(env.JWT_PRIVATE_KEY_PATH, 'utf-8');
  const pubPem = readFileSync(env.JWT_PUBLIC_KEY_PATH, 'utf-8');
  privateKey = await importPKCS8(privPem, 'RS256');
  publicKey = await importSPKI(pubPem, 'RS256');
}

export interface JWTPayload {
  sub: string;
  role: string;
  tenantId?: string;
  email: string;
  permissions: Record<string, { view: boolean; create: boolean; delete: boolean; scope: 'own' | 'all' }>;
}

export async function signAccessToken(payload: JWTPayload): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt()
    .setExpirationTime(`${env.JWT_ACCESS_TTL}s`)
    .setIssuer('treepbx')
    .sign(privateKey);
}

export async function signRefreshToken(userId: string): Promise<string> {
  return new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt()
    .setExpirationTime(`${env.JWT_REFRESH_TTL}s`)
    .setIssuer('treepbx')
    .sign(privateKey);
}

export async function verifyToken(token: string): Promise<JWTPayload> {
  const { payload } = await jwtVerify(token, publicKey, { issuer: 'treepbx' });
  return payload as unknown as JWTPayload;
}
