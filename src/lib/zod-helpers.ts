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
