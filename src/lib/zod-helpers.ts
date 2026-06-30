import { z } from 'zod';

/**
 * Optional UUID that gracefully handles empty strings from frontend.
 * Converts "" and short strings to undefined, then validates as UUID.
 */
export const optionalUuid = () =>
  z.string().optional().transform((v) => v && v.length > 10 ? v : undefined)
    .pipe(z.string().uuid().optional());

/**
 * Required email. Trims whitespace and lowercases before validating —
 * users routinely paste emails with trailing spaces. Use this on
 * create/update paths where the email is stored.
 */
export const email = () =>
  z.string().transform((v) => v.trim().toLowerCase()).pipe(z.string().email());

/**
 * Login-shaped email: trims whitespace but preserves case so we don't
 * silently break existing mixed-case stored emails on lookup.
 */
export const loginEmail = () =>
  z.string().transform((v) => v.trim()).pipe(z.string().email());

/**
 * Optional email that gracefully handles empty strings from frontend.
 * Trims, lowercases, and converts "" to undefined before validating.
 */
export const optionalEmail = () =>
  z.string().optional()
    .transform((v) => v?.trim().toLowerCase())
    .transform((v) => v && v.includes('@') ? v : undefined)
    .pipe(z.string().email().optional());

/**
 * Nullable UUID for body fields. Frontend may send "", null, or valid UUID.
 */
export const nullableUuid = () =>
  z.string().nullable().optional().transform((v) => v && v.length > 10 ? v : null);

// E.164 phones carry 7–15 digits. Allow common formatting characters that
// users routinely paste in (+, dashes, spaces, parens, dots) and cap raw
// length at 32. Junk like "0", "123", or "000000000000000000" is rejected.
const PHONE_REGEX = /^[+0-9\-() .]+$/;
const PHONE_MSG = 'Phone can only contain digits, +, -, spaces, parens, and dots';
const DIGITS_MSG = 'Phone must contain 7 to 15 digits';

export const phoneField = () =>
  z.string()
    .min(1, 'Phone is required')
    .max(32)
    .regex(PHONE_REGEX, PHONE_MSG)
    .refine((v) => {
      const digits = v.replace(/\D/g, '');
      return digits.length >= 7 && digits.length <= 15;
    }, { message: DIGITS_MSG });

// For optional/nullable contact phones (admin contacts, lead alt phone,
// etc). Empty string and null become null; anything else must validate.
export const nullablePhoneField = () =>
  z.string().nullable().optional()
    .transform((v) => (typeof v === 'string' ? v.trim() : v))
    .transform((v) => (v === '' ? null : v))
    .refine((v) => v == null || PHONE_REGEX.test(v), { message: PHONE_MSG })
    .refine((v) => {
      if (v == null) return true;
      const digits = v.replace(/\D/g, '');
      return digits.length >= 7 && digits.length <= 15;
    }, { message: DIGITS_MSG });
