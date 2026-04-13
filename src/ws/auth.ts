import { verifyToken, type JWTPayload } from '../lib/jwt';

export async function authenticateWs(url: string): Promise<JWTPayload | null> {
  try {
    const params = new URL(url, 'http://localhost').searchParams;
    const token = params.get('token');
    if (!token) return null;
    return await verifyToken(token);
  } catch {
    return null;
  }
}
