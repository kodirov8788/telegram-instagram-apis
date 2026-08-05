export const MAX_DELIVERY_ATTEMPTS = 8;

export function retryDelayMs(attempt: number, retryAfterMs?: number, random = Math.random): number {
  if (retryAfterMs !== undefined) return Math.min(Math.max(retryAfterMs, 1_000), 24 * 60 * 60 * 1_000);
  const base = Math.min(1_000 * 2 ** Math.max(0, attempt - 1), 60 * 60 * 1_000);
  return Math.round(base * (0.75 + random() * 0.5));
}
