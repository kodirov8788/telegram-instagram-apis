import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db', () => ({ query: vi.fn() }));

const jobMocks = vi.hoisted(() => ({
  claimNextJob: vi.fn(),
  markSent: vi.fn(),
  markRetryableFailed: vi.fn(),
  markPermanentFailed: vi.fn(),
  markAmbiguous: vi.fn(),
  markDispatched: vi.fn(),
}));
vi.mock('../../services/outbound-jobs', () => jobMocks);

const secretMocks = vi.hoisted(() => ({ getConnectionSecret: vi.fn() }));
vi.mock('../../services/connection-secret-loader', () => secretMocks);

const providerMocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  sendDirectMessage: vi.fn(),
}));
vi.mock('../../services/telegram', () => ({ TelegramService: class { sendMessage = providerMocks.sendMessage; } }));
vi.mock('../../services/instagram', () => ({ InstagramService: class { sendDirectMessage = providerMocks.sendDirectMessage; } }));

import { query } from '../../db';
import { processOutboundJob } from '../processors/outbound';
import { ProviderDeliveryError } from '../../services/provider-delivery-error';
import { RetryableWorkError } from '../errors';

const db = vi.mocked(query);

function baseJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    workspaceId: 'ws-1',
    connectionId: 'conn-1',
    channel: 'telegram' as const,
    messageId: 'msg-1',
    recipientId: 'tg-user-1',
    content: 'hello',
    status: 'processing' as const,
    attempts: 1,
    providerMessageId: null,
    lastError: null,
    nextAttemptAt: new Date(),
    sentAt: null,
    dispatchedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  db.mockReset();
  Object.values(jobMocks).forEach(m => m.mockReset());
  secretMocks.getConnectionSecret.mockReset();
  providerMocks.sendMessage.mockReset();
  providerMocks.sendDirectMessage.mockReset();
  db.mockImplementation((async (text: string) => {
    if (text.includes('FROM channel_connections')) return { rows: [{ id: 'conn-1', is_active: true }] };
    if (text.includes('UPDATE messages')) return { rows: [] };
    return { rows: [] };
  }) as never);
  secretMocks.getConnectionSecret.mockResolvedValue({ botToken: 'tok', pageAccessToken: 'tok' });
  jobMocks.markDispatched.mockResolvedValue(true);
});

describe('processOutboundJob', () => {
  it('returns skipped when nothing is claimable', async () => {
    jobMocks.claimNextJob.mockResolvedValue(null);

    const result = await processOutboundJob('job-1');

    expect(result).toEqual({ outcome: 'skipped' });
  });

  it('success: dispatches, marks sent, and updates messages.delivery_status to sent', async () => {
    jobMocks.claimNextJob.mockResolvedValue(baseJob());
    providerMocks.sendMessage.mockResolvedValue({ providerMessageId: 'prov-1' });

    const result = await processOutboundJob('job-1');

    expect(result).toEqual({ outcome: 'sent' });
    expect(jobMocks.markDispatched).toHaveBeenCalledWith('job-1');
    expect(jobMocks.markSent).toHaveBeenCalledWith('job-1', 'prov-1');
    const sentUpdate = db.mock.calls.find(c => typeof c[0] === 'string' && c[0].includes("delivery_status = $2") && c[1]?.[1] === 'sent');
    expect(sentUpdate).toBeTruthy();
  });

  it('429 with Retry-After: throws RetryableWorkError so the queue message is re-enqueued with delay', async () => {
    jobMocks.claimNextJob.mockResolvedValue(baseJob());
    providerMocks.sendMessage.mockRejectedValue(
      new ProviderDeliveryError('rate limited', { retryable: true, retryAfterMs: 4_000 })
    );

    await expect(processOutboundJob('job-1')).rejects.toBeInstanceOf(RetryableWorkError);
    expect(jobMocks.markRetryableFailed).toHaveBeenCalledWith('job-1', 'rate limited', 4_000);
  });

  it('500: retryable failure', async () => {
    jobMocks.claimNextJob.mockResolvedValue(baseJob());
    providerMocks.sendMessage.mockRejectedValue(new ProviderDeliveryError('server error', { retryable: true, statusCode: 500 }));

    await expect(processOutboundJob('job-1')).rejects.toBeInstanceOf(RetryableWorkError);
    expect(jobMocks.markRetryableFailed).toHaveBeenCalled();
  });

  it('timeout: routes to ambiguous, never retryable_failed', async () => {
    jobMocks.claimNextJob.mockResolvedValue(baseJob());
    providerMocks.sendMessage.mockRejectedValue(new ProviderDeliveryError('timed out', { retryable: true, ambiguous: true }));

    const result = await processOutboundJob('job-1');

    expect(result).toEqual({ outcome: 'ambiguous' });
    expect(jobMocks.markAmbiguous).toHaveBeenCalledWith('job-1', 'timed out');
    expect(jobMocks.markRetryableFailed).not.toHaveBeenCalled();
  });

  it('connection reset: routes to ambiguous', async () => {
    jobMocks.claimNextJob.mockResolvedValue(baseJob());
    providerMocks.sendMessage.mockRejectedValue(
      new ProviderDeliveryError('network error', { retryable: true, ambiguous: true })
    );

    const result = await processOutboundJob('job-1');

    expect(result.outcome).toBe('ambiguous');
  });

  it('malformed response: retryable, not ambiguous', async () => {
    jobMocks.claimNextJob.mockResolvedValue(baseJob());
    providerMocks.sendMessage.mockRejectedValue(new ProviderDeliveryError('bad json', { retryable: true, ambiguous: false }));

    await expect(processOutboundJob('job-1')).rejects.toBeInstanceOf(RetryableWorkError);
    expect(jobMocks.markRetryableFailed).toHaveBeenCalled();
    expect(jobMocks.markAmbiguous).not.toHaveBeenCalled();
  });

  it('invalid credential (permanent provider error): permanent_failed, not retried', async () => {
    jobMocks.claimNextJob.mockResolvedValue(baseJob());
    providerMocks.sendMessage.mockRejectedValue(new ProviderDeliveryError('unauthorized', { retryable: false, statusCode: 401 }));

    const result = await processOutboundJob('job-1');

    expect(result).toEqual({ outcome: 'permanent_failed' });
    expect(jobMocks.markPermanentFailed).toHaveBeenCalledWith('job-1', 'unauthorized');
  });

  it('inactive connection: permanent_failed, provider never called', async () => {
    jobMocks.claimNextJob.mockResolvedValue(baseJob());
    db.mockImplementation((async (text: string) => {
      if (text.includes('FROM channel_connections')) return { rows: [{ id: 'conn-1', is_active: false }] };
      return { rows: [] };
    }) as never);

    const result = await processOutboundJob('job-1');

    expect(result).toEqual({ outcome: 'permanent_failed' });
    expect(providerMocks.sendMessage).not.toHaveBeenCalled();
    expect(jobMocks.markDispatched).not.toHaveBeenCalled();
  });

  it('missing credential (fail-closed getConnectionSecret): permanent_failed, provider never called', async () => {
    jobMocks.claimNextJob.mockResolvedValue(baseJob());
    secretMocks.getConnectionSecret.mockResolvedValue(null);

    const result = await processOutboundJob('job-1');

    expect(result).toEqual({ outcome: 'permanent_failed' });
    expect(providerMocks.sendMessage).not.toHaveBeenCalled();
    expect(jobMocks.markDispatched).not.toHaveBeenCalled();
  });

  it('worker crash before provider call is simulated by claim/dispatched-marker never running the provider on a fresh job (control case: provider IS called for a genuinely un-dispatched job)', async () => {
    jobMocks.claimNextJob.mockResolvedValue(baseJob({ dispatchedAt: null, providerMessageId: null }));
    providerMocks.sendMessage.mockResolvedValue({ providerMessageId: 'prov-2' });

    const result = await processOutboundJob('job-1');

    expect(result).toEqual({ outcome: 'sent' });
    expect(providerMocks.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('THE critical guarantee: a reclaimed job with dispatched_at set and no provider_message_id NEVER calls the provider again — routes straight to ambiguous', async () => {
    jobMocks.claimNextJob.mockResolvedValue(baseJob({ dispatchedAt: new Date(Date.now() - 20 * 60 * 1000), providerMessageId: null }));

    const result = await processOutboundJob('job-1');

    expect(result).toEqual({ outcome: 'ambiguous' });
    expect(providerMocks.sendMessage).not.toHaveBeenCalled();
    expect(providerMocks.sendDirectMessage).not.toHaveBeenCalled();
    expect(jobMocks.markAmbiguous).toHaveBeenCalledWith('job-1', expect.stringContaining('unconfirmed'));
    expect(jobMocks.markDispatched).not.toHaveBeenCalled();
  });

  it('worker crash after dispatched_at but before response persistence: markDispatched returning false (concurrent/duplicate dispatch) routes to ambiguous without calling the provider again', async () => {
    jobMocks.claimNextJob.mockResolvedValue(baseJob());
    jobMocks.markDispatched.mockResolvedValue(false);

    const result = await processOutboundJob('job-1');

    expect(result).toEqual({ outcome: 'ambiguous' });
    expect(providerMocks.sendMessage).not.toHaveBeenCalled();
  });

  it('instagram channel dispatches via InstagramService', async () => {
    jobMocks.claimNextJob.mockResolvedValue(baseJob({ channel: 'instagram', recipientId: 'ig-user-1' }));
    providerMocks.sendDirectMessage.mockResolvedValue({ providerMessageId: 'ig-prov-1' });

    const result = await processOutboundJob('job-1');

    expect(result).toEqual({ outcome: 'sent' });
    expect(providerMocks.sendDirectMessage).toHaveBeenCalledWith('ig-user-1', 'hello');
  });

  it('exhausted attempt budget: treated as permanent_failed even for a retryable provider error', async () => {
    jobMocks.claimNextJob.mockResolvedValue(baseJob({ attempts: 5 }));
    providerMocks.sendMessage.mockRejectedValue(new ProviderDeliveryError('server error', { retryable: true, statusCode: 500 }));

    const result = await processOutboundJob('job-1');

    expect(result).toEqual({ outcome: 'permanent_failed' });
    expect(jobMocks.markPermanentFailed).toHaveBeenCalled();
    expect(jobMocks.markRetryableFailed).not.toHaveBeenCalled();
  });
});
