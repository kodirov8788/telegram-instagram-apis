import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DbClient } from '@/lib/db';
import { TestQueueAdapter } from '@/lib/queue/test-adapter';
import { processWorkerBatch } from '../runtime';
import { RetryableWorkError } from '../errors';

const mocks = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock('../transaction', () => ({ queueWorkerTransaction: mocks.transaction }));

const client: DbClient = { query: vi.fn(async () => ({ rows: [] })) };
const VALID_ID = 'a3d65b16-43c3-4d40-84cf-cb5c5cc1baaa';

describe('processWorkerBatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(async (callback: any) => callback(client));
  });

  it('processes and deletes a valid message', async () => {
    const adapter = new TestQueueAdapter();
    await adapter.send(client, 'inbound_events', { v: 1, providerEventId: VALID_ID });
    const process = vi.fn().mockResolvedValue(undefined);

    const count = await processWorkerBatch({ queue: 'inbound_events', process, adapter });

    expect(count).toBe(1);
    expect(process).toHaveBeenCalledWith(VALID_ID);
    expect(adapter.getMessages()[0].deleted).toBe(true);
  });

  it('archives a malformed message without blocking the rest of the batch', async () => {
    const adapter = new TestQueueAdapter();
    const validId = 'b78a9cde-1234-4678-90ab-cdef12345678';
    await adapter.send(client, 'inbound_events', { v: 1, providerEventId: validId });
    // Simulate corruption injected outside the normal send() path.
    (adapter.getMessages() as any).unshift({
      id: BigInt(99),
      queue: 'inbound_events',
      payload: { unexpected: 'shape' },
      enqueuedAt: new Date(),
      visibleAt: new Date(),
      readCount: 0,
      archived: false,
      deleted: false,
    });
    const process = vi.fn().mockResolvedValue(undefined);

    await processWorkerBatch({ queue: 'inbound_events', process, adapter, logger: { info: vi.fn(), error: vi.fn() } });

    expect(process).toHaveBeenCalledWith(validId);
    expect(process).toHaveBeenCalledTimes(1);
    expect(adapter.getMessages().find(m => m.id === BigInt(99))?.archived).toBe(true);
  });

  it('archives a message once it hits maxAttempts', async () => {
    const adapter = new TestQueueAdapter();
    await adapter.send(client, 'inbound_events', { v: 1, providerEventId: VALID_ID });
    adapter.getMessages()[0].readCount = 4;

    await processWorkerBatch({
      queue: 'inbound_events',
      adapter,
      maxAttempts: 5,
      process: vi.fn().mockRejectedValue(new Error('boom')),
      logger: { info: vi.fn(), error: vi.fn() },
    });

    expect(adapter.getMessages()[0].archived).toBe(true);
  });

  it('leaves a message in place for pgmq redelivery when under maxAttempts', async () => {
    const adapter = new TestQueueAdapter();
    await adapter.send(client, 'inbound_events', { v: 1, providerEventId: VALID_ID });
    adapter.getMessages()[0].readCount = 1;

    await processWorkerBatch({
      queue: 'inbound_events',
      adapter,
      maxAttempts: 8,
      process: vi.fn().mockRejectedValue(new Error('transient')),
      logger: { info: vi.fn(), error: vi.fn() },
    });

    const stored = adapter.getMessages()[0];
    expect(stored.archived).toBe(false);
    expect(stored.deleted).toBe(false);
  });

  it('atomically replaces retryable work with a delayed re-enqueue', async () => {
    const adapter = new TestQueueAdapter();
    await adapter.send(client, 'inbound_events', { v: 1, providerEventId: VALID_ID });

    await processWorkerBatch({
      queue: 'inbound_events',
      adapter,
      process: vi.fn().mockRejectedValue(new RetryableWorkError(12_000)),
    });

    const all = adapter.getMessages();
    expect(all.filter(m => m.deleted)).toHaveLength(1); // original deleted
    const replacement = all.find(m => !m.deleted);
    expect(replacement?.payload).toEqual({ v: 1, providerEventId: VALID_ID });
    expect(replacement!.visibleAt.getTime()).toBeGreaterThan(Date.now() + 10_000);
  });

  it('returns 0 for an empty queue, so the caller can back off before polling again', async () => {
    const adapter = new TestQueueAdapter();
    const count = await processWorkerBatch({ queue: 'inbound_events', process: vi.fn(), adapter });
    expect(count).toBe(0);
  });
});
