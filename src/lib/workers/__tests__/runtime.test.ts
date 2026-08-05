import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TestQueueAdapter } from '@/lib/queue/test-adapter';
import { processWorkerBatch } from '../runtime';
import type { DbClient } from '@/lib/db';

const mocks = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock('@/lib/db', () => ({
  runtimeRoleTransaction: mocks.transaction,
}));

const client: DbClient = { query: vi.fn(async () => ({ rows: [] })) };

describe('worker runtime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(async callback => callback(client));
  });

  it('processes and deletes valid messages', async () => {
    const adapter = new TestQueueAdapter();
    const id = 'a3d65b16-43c3-4d40-84cf-cb5c5cc1baaa';
    await adapter.send(client, 'inbound_events', { v: 1, providerEventId: id });
    const process = vi.fn().mockResolvedValue(undefined);

    expect(await processWorkerBatch({ queue: 'inbound_events', process, adapter })).toBe(1);
    expect(process).toHaveBeenCalledWith(id);
    expect(adapter.getMessages()[0].deleted).toBe(true);
  });

  it('archives malformed items without blocking valid batch peers', async () => {
    const adapter = new TestQueueAdapter();
    const id = 'b78a9cde-1234-4678-90ab-cdef12345678';
    await adapter.send(client, 'inbound_events', { v: 1, providerEventId: id });
    // Deliberately inject corruption as though an operator wrote directly to pgmq.
    adapter.getMessages().unshift({
      id: BigInt(99), queue: 'inbound_events', payload: { secret: 'must-not-log' },
      enqueuedAt: new Date(), visibleAt: new Date(), readCount: 0,
      archived: false, deleted: false,
    });
    const process = vi.fn().mockResolvedValue(undefined);

    await processWorkerBatch({ queue: 'inbound_events', process, adapter, logger: { info: vi.fn(), error: vi.fn() } });
    expect(process).toHaveBeenCalledWith(id);
    expect(adapter.getMessages().find(message => message.id === BigInt(99))?.archived).toBe(true);
  });

  it('archives poison messages at the maximum attempt count', async () => {
    const adapter = new TestQueueAdapter();
    await adapter.send(client, 'outbound_messages', {
      v: 1, outboundJobId: 'c78a9cde-1234-4678-90ab-cdef12345678',
    });
    adapter.getMessages()[0].readCount = 4;

    await processWorkerBatch({
      queue: 'outbound_messages', adapter, maxAttempts: 5,
      process: vi.fn().mockRejectedValue(new Error('sensitive upstream detail')),
      logger: { info: vi.fn(), error: vi.fn() },
    });
    expect(adapter.getMessages()[0].archived).toBe(true);
  });
});
