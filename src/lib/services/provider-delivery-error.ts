/**
 * Typed error both TelegramService and InstagramService throw for every
 * delivery failure mode, so the outbound processor can branch on
 * `retryable`/`retryAfterMs` without any provider-specific logic.
 *
 * `retryable`:
 *  - true  for 429, 5xx, timeout/AbortError, network reset/ECONNRESET,
 *    and malformed response bodies (JSON parse failure) — none of these
 *    reliably indicate a permanent condition.
 *  - false for 401/403/invalid-credential-shaped errors (won't fix
 *    themselves on retry) and any other 4xx that isn't 429.
 *
 * `ambiguous`: true only for the cases where the provider may have already
 * received/processed the send before the failure was observed (timeout,
 * network reset) — the outbound worker must route these to `ambiguous`
 * instead of `retryable_failed`, since blindly retrying risks a duplicate
 * send.
 */
export class ProviderDeliveryError extends Error {
  readonly retryable: boolean;
  readonly ambiguous: boolean;
  readonly retryAfterMs?: number;
  readonly statusCode?: number;

  constructor(
    message: string,
    opts: { retryable: boolean; ambiguous?: boolean; retryAfterMs?: number; statusCode?: number; cause?: unknown }
  ) {
    super(message);
    this.name = 'ProviderDeliveryError';
    this.retryable = opts.retryable;
    this.ambiguous = opts.ambiguous ?? false;
    this.retryAfterMs = opts.retryAfterMs;
    this.statusCode = opts.statusCode;
    if (opts.cause !== undefined) (this as any).cause = opts.cause;
  }
}

/** Parses a Retry-After header value: either delta-seconds or an HTTP-date. Returns ms, or undefined if unparseable. */
export function parseRetryAfterMs(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const dateMs = Date.parse(headerValue);
  if (!Number.isNaN(dateMs)) {
    const deltaMs = dateMs - Date.now();
    return deltaMs > 0 ? deltaMs : 0;
  }
  return undefined;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Runs `fetch` with a 15s AbortController timeout. Distinguishes an
 * abort-due-to-timeout (ambiguous — the request may have reached the
 * server) from a network error (also ambiguous, treated the same way here
 * since neither confirms whether the provider received the request) by
 * throwing a `ProviderDeliveryError` with `ambiguous: true` for both.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      throw new ProviderDeliveryError('Provider request timed out', { retryable: true, ambiguous: true, cause: error });
    }
    // Network reset / connection failure — the request may or may not have
    // reached the provider; treat as ambiguous rather than a clean failure.
    throw new ProviderDeliveryError('Provider request failed due to a network error', {
      retryable: true,
      ambiguous: true,
      cause: error,
    });
  } finally {
    clearTimeout(timer);
  }
}
