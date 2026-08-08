import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TelegramService } from '../telegram';
import { ProviderDeliveryError } from '../provider-delivery-error';

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

describe('TelegramService.sendMessage', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the provider message id on success', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true, result: { message_id: 555 } }));

    const result = await new TelegramService('tok').sendMessage('123', 'hi');

    expect(result.providerMessageId).toBe('555');
  });

  it('429 with numeric Retry-After header: retryable with retryAfterMs', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(429, { ok: false, description: 'rate limited' }, { 'retry-after': '3' }));

    const err = await new TelegramService('tok').sendMessage('123', 'hi').catch(e => e);

    expect(err).toBeInstanceOf(ProviderDeliveryError);
    expect(err.retryable).toBe(true);
    expect(err.retryAfterMs).toBe(3_000);
  });

  it('429 with retry_after in the JSON body (Telegram-specific shape) when no header is present', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(429, { ok: false, description: 'rate limited', parameters: { retry_after: 7 } }));

    const err = await new TelegramService('tok').sendMessage('123', 'hi').catch(e => e);

    expect(err.retryable).toBe(true);
    expect(err.retryAfterMs).toBe(7_000);
  });

  it('5xx is retryable', async () => {
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 502 }));

    const err = await new TelegramService('tok').sendMessage('123', 'hi').catch(e => e);

    expect(err).toBeInstanceOf(ProviderDeliveryError);
    expect(err.retryable).toBe(true);
    expect(err.statusCode).toBe(502);
  });

  it('15s timeout: retryable and ambiguous (the provider may have received the request)', async () => {
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

      const promise = new TelegramService('tok').sendMessage('123', 'hi').catch(e => e);
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

    const err = await new TelegramService('tok').sendMessage('123', 'hi').catch(e => e);

    expect(err).toBeInstanceOf(ProviderDeliveryError);
    expect(err.retryable).toBe(true);
    expect(err.ambiguous).toBe(true);
  });

  it('malformed response body (invalid JSON): retryable, not ambiguous', async () => {
    fetchMock.mockResolvedValueOnce(new Response('not json', { status: 200 }));

    const err = await new TelegramService('tok').sendMessage('123', 'hi').catch(e => e);

    expect(err).toBeInstanceOf(ProviderDeliveryError);
    expect(err.retryable).toBe(true);
    expect(err.ambiguous).toBe(false);
  });

  it('invalid credential (401/403-shaped error): permanent, not retryable', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: false, error_code: 401, description: 'Unauthorized' }));

    const err = await new TelegramService('bad-tok').sendMessage('123', 'hi').catch(e => e);

    expect(err).toBeInstanceOf(ProviderDeliveryError);
    expect(err.retryable).toBe(false);
  });

  it('other 4xx (e.g. 400 bad chat id): permanent, not retryable', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: false, error_code: 400, description: 'chat not found' }));

    const err = await new TelegramService('tok').sendMessage('123', 'hi').catch(e => e);

    expect(err.retryable).toBe(false);
  });
});
