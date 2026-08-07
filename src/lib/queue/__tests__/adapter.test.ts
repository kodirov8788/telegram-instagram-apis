import { describe, expect, it } from 'vitest';
import type { DbClient } from '../../db';
import { PgmqQueueAdapter } from '../pgmq-adapter';
import { TestQueueAdapter } from '../test-adapter';
import { QueueValidationError } from '../errors';

const dummyClient: DbClient = { query: async () => ({ rows: [] }) };
const VALID_ID = 'a3d65b16-43c3-4d40-84cf-cb5c5cc1baaa';

describe.each([
  ['PgmqQueueAdapter', () => new PgmqQueueAdapter()],
  ['TestQueueAdapter', () => new TestQueueAdapter()],
])('%s payload validation', (_name, makeAdapter) => {
  it('rejects a non-object payload', async () => {
    const adapter = makeAdapter();
    await expect(adapter.send(dummyClient, 'inbound_events', null as any)).rejects.toThrow(QueueValidationError);
  });

  it('rejects an incorrect version', async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.send(dummyClient, 'inbound_events', { v: 2, providerEventId: VALID_ID } as any)
    ).rejects.toThrow(QueueValidationError);
  });

  it('rejects extra properties', async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.send(dummyClient, 'inbound_events', { v: 1, providerEventId: VALID_ID, extra: 'field' } as any)
    ).rejects.toThrow(QueueValidationError);
  });

  it('rejects a non-UUID providerEventId', async () => {
    const adapter = makeAdapter();
    await expect(adapter.send(dummyClient, 'inbound_events', { v: 1, providerEventId: 'not-a-uuid' } as any)).rejects.toThrow(
      QueueValidationError
    );
  });

  it('rejects a negative delay', async () => {
    const adapter = makeAdapter();
    await expect(adapter.send(dummyClient, 'inbound_events', { v: 1, providerEventId: VALID_ID }, -1)).rejects.toThrow(
      QueueValidationError
    );
  });
});

describe('TestQueueAdapter in-memory semantics', () => {
  it('sends, reads, and deletes a message', async () => {
    const adapter = new TestQueueAdapter();
    const payload = { v: 1 as const, providerEventId: VALID_ID };
    const id = await adapter.send(dummyClient, 'inbound_events', payload);
    expect(id).toBe(BigInt(1));

    const read = await adapter.read(dummyClient, 'inbound_events', { limit: 1 });
    expect(read).toHaveLength(1);
    expect(read[0].payload).toEqual(payload);
    expect(read[0].readCount).toBe(1);

    // hidden immediately after read (default visibility timeout applies)
    expect(await adapter.read(dummyClient, 'inbound_events', { limit: 1 })).toHaveLength(0);

    expect(await adapter.delete(dummyClient, 'inbound_events', id)).toBe(true);
    expect(await adapter.delete(dummyClient, 'inbound_events', id)).toBe(false); // already deleted
  });

  it('reappears after its visibility timeout expires, with an incremented read count', async () => {
    let now = new Date('2026-01-01T00:00:00Z');
    const adapter = new TestQueueAdapter(() => now);
    const payload = { v: 1 as const, providerEventId: VALID_ID };
    await adapter.send(dummyClient, 'inbound_events', payload);

    const first = await adapter.read(dummyClient, 'inbound_events', { visibilityTimeout: 10, limit: 1 });
    expect(first[0].readCount).toBe(1);
    expect(await adapter.read(dummyClient, 'inbound_events', { limit: 1 })).toHaveLength(0);

    now = new Date(now.getTime() + 11_000);

    const second = await adapter.read(dummyClient, 'inbound_events', { limit: 1 });
    expect(second).toHaveLength(1);
    expect(second[0].readCount).toBe(2);
  });

  it('archived messages are not readable and cannot be archived twice', async () => {
    const adapter = new TestQueueAdapter();
    const id = await adapter.send(dummyClient, 'inbound_events', { v: 1, providerEventId: VALID_ID });
    expect(await adapter.archive(dummyClient, 'inbound_events', id)).toBe(true);
    expect(await adapter.archive(dummyClient, 'inbound_events', id)).toBe(false);
    expect(await adapter.read(dummyClient, 'inbound_events', { limit: 5 })).toHaveLength(0);
  });

  it('enforces batch-size and visibility-timeout bounds', async () => {
    const adapter = new TestQueueAdapter();
    await expect(adapter.read(dummyClient, 'inbound_events', { limit: 0 })).rejects.toThrow(QueueValidationError);
    await expect(adapter.read(dummyClient, 'inbound_events', { limit: 6 })).rejects.toThrow(QueueValidationError);
    await expect(adapter.read(dummyClient, 'inbound_events', { visibilityTimeout: 0 })).rejects.toThrow(QueueValidationError);
  });
});
