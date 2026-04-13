import { nanoid } from 'nanoid';

export function generateApiKey(): { key: string; prefix: string; hash: string } {
  const key = `tpbx_${nanoid(40)}`;
  const prefix = key.slice(0, 12);
  const hash = Bun.hash(key).toString();
  return { key, prefix, hash };
}

export async function hmacSign(secret: string, payload: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return Buffer.from(sig).toString('hex');
}
