import { describe, expect, it, vi } from 'vitest';
import { TelegramProviderError } from '../../services/telegram';
import { processOutboundJob } from '../processors/outbound';
import { retryDelayMs } from '../retry';

function harness(send: () => Promise<{ providerMessageId: string }>) {
  const queries: Array<{ text: string; params?: unknown[] }> = [];
  let calls = 0;
  const transaction = async <T>(operation: (db: any) => Promise<T>) => operation({
    query: async (text: string, params?: unknown[]) => {
      queries.push({ text, params });
      if (text.includes('RETURNING j.*')) {
        calls++;
        return { rows: calls === 1 ? [{ id: 'job', workspace_id: 'ws', connection_id: 'conn', message_id: 'message', provider: 'telegram', recipient_id: 'chat', attempts: 1, content: 'private body' }] : [] };
      }
      return { rows: [] };
    },
  });
  const secrets = { getConnectionSecret: vi.fn().mockResolvedValue({ accessToken: 'secret-token' }) };
  const sender = { send: vi.fn(send) };
  return { queries, transaction, secrets, sender };
}

describe('processOutboundJob', () => {
  it('marks message sent only after provider acknowledgement', async () => {
    const h = harness(async () => ({ providerMessageId: 'provider-1' }));
    await expect(processOutboundJob('job', h.secrets, h)).resolves.toEqual({ outcome: 'sent' });
    expect(h.sender.send).toHaveBeenCalledWith('telegram', 'secret-token', 'chat', 'private body');
    expect(h.queries.some(q => q.text.includes("delivery_status = 'sent'"))).toBe(true);
    expect(JSON.stringify(h.queries)).not.toContain('secret-token');
  });

  it('honors provider retry-after without marking the message failed', async () => {
    const h = harness(async () => { throw new TelegramProviderError('Telegram request failed (429)', true, 12_000); });
    await expect(processOutboundJob('job', h.secrets, { ...h, random: () => 0 })).resolves.toEqual({ outcome: 'retryable_failed', retryInMs: 12_000 });
    const retry = h.queries.find(q => q.text.includes("next_attempt_at = CASE"));
    expect(retry?.params).toEqual(['job', 'retryable_failed', 'Telegram request failed (429)', 12_000]);
    expect(h.queries.some(q => q.text.includes("delivery_status = 'failed'"))).toBe(false);
  });

  it('marks permanent provider rejection failed', async () => {
    const h = harness(async () => { throw new TelegramProviderError('Telegram request failed (400)', false); });
    await expect(processOutboundJob('job', h.secrets, h)).resolves.toMatchObject({ outcome: 'permanent_failed' });
    expect(h.queries.some(q => q.text.includes("delivery_status = 'failed'"))).toBe(true);
  });
});

describe('retryDelayMs', () => {
  it('uses bounded exponential backoff with jitter', () => {
    expect(retryDelayMs(3, undefined, () => 0)).toBe(3_000);
    expect(retryDelayMs(99, undefined, () => 1)).toBe(4_500_000);
  });
});
