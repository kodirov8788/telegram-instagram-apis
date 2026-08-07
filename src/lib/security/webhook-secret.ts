import { timingSafeEqual } from 'node:crypto';

/**
 * Constant-time comparison for a webhook's shared-secret header (e.g.
 * Telegram's `X-Telegram-Bot-Api-Secret-Token`, set per-bot via `setWebhook`
 * and echoed back on every delivery). Unlike Meta's HMAC signature, this is
 * a plain secret comparison — Telegram does not sign the body.
 */
export function secretsMatch(expected: string | null | undefined, provided: string | null | undefined): boolean {
  if (!expected || !provided) return false;

  const expectedBuf = Buffer.from(expected, 'utf8');
  const providedBuf = Buffer.from(provided, 'utf8');
  if (expectedBuf.length !== providedBuf.length) return false;

  return timingSafeEqual(expectedBuf, providedBuf);
}
