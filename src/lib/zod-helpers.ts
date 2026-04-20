import { z } from 'zod';

/**
 * Optional UUID that gracefully handles empty strings from frontend.
 * Converts "" and short strings to undefined, then validates as UUID.
 */
export const optionalUuid = () =>
  z.string().optional().transform((v) => v && v.length > 10 ? v : undefined)
    .pipe(z.string().uuid().optional());

/**
 * Optional email that gracefully handles empty strings from frontend.
 * Converts "" to undefined before validating.
 */
export const optionalEmail = () =>
  z.string().optional().transform((v) => v && v.includes('@') ? v : undefined)
    .pipe(z.string().email().optional());

/**
 * Nullable UUID for body fields. Frontend may send "", null, or valid UUID.
 */
export const nullableUuid = () =>
  z.string().nullable().optional().transform((v) => v && v.length > 10 ? v : null);
