import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InstagramService } from '../instagram';
import { ProviderDeliveryError } from '../provider-delivery-error';

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

describe('InstagramService.sendDirectMessage', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the provider message id on success', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { message_id: 'mid.123', recipient_id: 'r1' }));

    const result = await new InstagramService('tok').sendDirectMessage('r1', 'hi');

    expect(result.providerMessageId).toBe('mid.123');
  });

  it('429 with Retry-After header: retryable with retryAfterMs', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(429, { error: { message: 'rate limited' } }, { 'retry-after': '2' }));

    const err = await new InstagramService('tok').sendDirectMessage('r1', 'hi').catch(e => e);

    expect(err).toBeInstanceOf(ProviderDeliveryError);
    expect(err.retryable).toBe(true);
    expect(err.retryAfterMs).toBe(2_000);
  });

  it('5xx is retryable', async () => {
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 503 }));

    const err = await new InstagramService('tok').sendDirectMessage('r1', 'hi').catch(e => e);

    expect(err).toBeInstanceOf(ProviderDeliveryError);
    expect(err.retryable).toBe(true);
  });

  it('15s timeout: retryable and ambiguous', async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockImplementationOnce((_url: string, init: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const abortError = new Error('aborted');
            abortError.name = 'AbortError';
            reject(abortError);
          });
        });
      });

      const promise = new InstagramService('tok').sendDirectMessage('r1', 'hi').catch(e => e);
      await vi.advanceTimersByTimeAsync(15_000);
      const err = await promise;

      expect(err).toBeInstanceOf(ProviderDeliveryError);
      expect(err.retryable).toBe(true);
      expect(err.ambiguous).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('network reset / connection failure: retryable and ambiguous', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed: ECONNRESET'));

    const err = await new InstagramService('tok').sendDirectMessage('r1', 'hi').catch(e => e);

    expect(err).toBeInstanceOf(ProviderDeliveryError);
    expect(err.retryable).toBe(true);
    expect(err.ambiguous).toBe(true);
  });

  it('malformed response body (invalid JSON): retryable, not ambiguous', async () => {
    fetchMock.mockResolvedValueOnce(new Response('not json', { status: 200 }));

    const err = await new InstagramService('tok').sendDirectMessage('r1', 'hi').catch(e => e);

    expect(err).toBeInstanceOf(ProviderDeliveryError);
    expect(err.retryable).toBe(true);
    expect(err.ambiguous).toBe(false);
  });

  it('invalid credential (OAuthException): permanent, not retryable', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(400, { error: { message: 'Invalid OAuth access token', type: 'OAuthException', code: 190 } })
    );

    const err = await new InstagramService('bad-tok').sendDirectMessage('r1', 'hi').catch(e => e);

    expect(err).toBeInstanceOf(ProviderDeliveryError);
    expect(err.retryable).toBe(false);
  });
});
