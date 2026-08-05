import { describe, expect, it, vi } from 'vitest';
import { TelegramProviderError } from '../../services/telegram';
import { processOutboundJob } from '../processors/outbound';
import { retryDelayMs } from '../retry';

function harness(
  send: () => Promise<{ providerMessageId: string }>,
  job: Partial<Record<string, unknown>> = {},
  secretError?: Error
) {
  const queries: Array<{ text: string; params?: unknown[] }> = [];
  let calls = 0;
  const transaction = async <T>(operation: (db: any) => Promise<T>) => operation({
    query: async (text: string, params?: unknown[]) => {
      queries.push({ text, params });
      if (text.includes('RETURNING j.*')) {
        calls++;
        return { rows: calls === 1 ? [{ id: 'job', workspace_id: 'ws', connection_id: 'conn', message_id: 'message', provider: 'telegram', recipient_id: 'chat', attempts: 1, content: 'private body', dispatched_at: null, provider_message_id: null, ...job }] : [] };
      }
      if (text.includes('RETURNING id')) return { rows: [{ id: 'job' }] };
      return { rows: [] };
    },
  });
  const secrets = { getConnectionSecret: vi.fn().mockResolvedValue({ accessToken: 'secret-token' }) };
  if (secretError) secrets.getConnectionSecret.mockRejectedValue(secretError);
  const sender = { send: vi.fn(send) };
  return { queries, transaction, secrets, sender };
}

describe('processOutboundJob', () => {
  it('marks message sent only after provider acknowledgement', async () => {
    const h = harness(async () => ({ providerMessageId: 'provider-1' }));
    await expect(processOutboundJob('job', h.secrets, h)).resolves.toEqual({ outcome: 'sent' });
    expect(h.sender.send).toHaveBeenCalledWith('telegram', 'secret-token', 'chat', 'private body');
    expect(h.queries.some(q => q.text.includes('dispatched_at = NOW()'))).toBe(true);
    expect(h.queries.some(q => q.text.includes("delivery_status = 'sent'"))).toBe(true);
    expect(JSON.stringify(h.queries)).not.toContain('secret-token');
  });

  it('marks a provider-call failure ambiguous after recording dispatch', async () => {
    const h = harness(async () => { throw new TelegramProviderError('Telegram request failed (429)', true, 12_000); });
    await expect(processOutboundJob('job', h.secrets, { ...h, random: () => 0 })).resolves.toEqual({ outcome: 'ambiguous' });
    expect(h.queries.some(q => q.text.includes("status = 'ambiguous'"))).toBe(true);
    expect(h.queries.some(q => q.text.includes("delivery_status = 'unknown'"))).toBe(true);
  });

  it('does not call the provider when reclaiming a dispatched job without an acknowledgement', async () => {
    const h = harness(async () => ({ providerMessageId: 'should-not-send' }), { dispatched_at: '2026-08-06T00:00:00Z' });
    await expect(processOutboundJob('job', h.secrets, h)).resolves.toEqual({ outcome: 'ambiguous' });
    expect(h.secrets.getConnectionSecret).not.toHaveBeenCalled();
    expect(h.sender.send).not.toHaveBeenCalled();
    expect(h.queries.some(q => q.text.includes("delivery_status = 'unknown'"))).toBe(true);
  });

  it('retries a failure that occurs before dispatch is recorded', async () => {
    const h = harness(async () => ({ providerMessageId: 'unused' }), {}, new Error('secret store unavailable'));
    await expect(processOutboundJob('job', h.secrets, { ...h, random: () => 0 })).rejects.toThrow('retryable');
    expect(h.sender.send).not.toHaveBeenCalled();
    expect(h.queries.some(q => q.text.includes('dispatched_at = NOW()'))).toBe(false);
    expect(h.queries.find(q => q.text.includes("next_attempt_at = CASE"))?.params).toEqual([
      'job', 'retryable_failed', 'Provider delivery failed', 750,
    ]);
  });
});

describe('retryDelayMs', () => {
  it('uses bounded exponential backoff with jitter', () => {
    expect(retryDelayMs(3, undefined, () => 0)).toBe(3_000);
    expect(retryDelayMs(99, undefined, () => 1)).toBe(4_500_000);
  });
});
