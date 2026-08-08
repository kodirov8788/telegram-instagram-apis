export const MAX_DELIVERY_ATTEMPTS = 8;

/** Distinct, smaller attempt budget for outbound provider deliveries (issue #46) — does not replace MAX_DELIVERY_ATTEMPTS. */
export const MAX_DELIVERY_ATTEMPTS_OUTBOUND = 5;

/** Bounded exponential backoff (capped at 1h) with +/-25% jitter, or an explicit override clamped to [1s, 24h]. */
export function retryDelayMs(attempt: number, retryAfterMs?: number, random: () => number = Math.random): number {
  if (retryAfterMs !== undefined) {
    return Math.min(Math.max(retryAfterMs, 1_000), 24 * 60 * 60 * 1_000);
  }
  const base = Math.min(1_000 * 2 ** Math.max(0, attempt - 1), 60 * 60 * 1_000);
  return Math.round(base * (0.75 + random() * 0.5));
}
