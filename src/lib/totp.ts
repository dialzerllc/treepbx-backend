/**
 * Minimal RFC 6238 TOTP (Time-based One-Time Password) generator/verifier.
 * SHA-1, 30-second period, 6-digit code — matches Google/Microsoft/1Password
 * Authenticator defaults so users can scan and go.
 *
 * Secrets are stored base32-encoded (RFC 4648, no padding) the way most apps
 * expect them in `otpauth://` URIs.
 */

import { createHmac, randomBytes } from 'crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function generateBase32Secret(bytes = 20): string {
  const buf = randomBytes(bytes);
  let bits = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    out += BASE32_ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
  }
  return out;
}

function base32Decode(secret: string): Buffer {
  const cleaned = secret.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = '';
  for (const ch of cleaned) {
    const i = BASE32_ALPHABET.indexOf(ch);
    if (i < 0) throw new Error('Invalid base32 character');
    bits += i.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

function hotp(secret: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter), 0);
  const hmac = createHmac('sha1', secret).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24) |
               ((hmac[offset + 1] & 0xff) << 16) |
               ((hmac[offset + 2] & 0xff) << 8) |
               (hmac[offset + 3] & 0xff);
  return (code % 1_000_000).toString().padStart(6, '0');
}

export function generateTotp(secret: string, atSeconds: number = Math.floor(Date.now() / 1000)): string {
  return hotp(base32Decode(secret), Math.floor(atSeconds / 30));
}

/**
 * Accept ±1 step (30-second window each side) to tolerate small clock drift on
 * the user's authenticator. Returns true if the supplied 6-digit code matches.
 */
export function verifyTotp(secret: string, code: string, atSeconds: number = Math.floor(Date.now() / 1000)): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const buf = base32Decode(secret);
  const step = Math.floor(atSeconds / 30);
  for (const offset of [-1, 0, 1]) {
    if (hotp(buf, step + offset) === code) return true;
  }
  return false;
}

/**
 * Build an otpauth:// URL for the QR scan. issuer + account both surface in
 * the user's authenticator app entry list.
 */
export function buildOtpauthUrl(opts: { issuer: string; accountName: string; secret: string }): string {
  const label = encodeURIComponent(`${opts.issuer}:${opts.accountName}`);
  const params = new URLSearchParams({
    secret: opts.secret,
    issuer: opts.issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
