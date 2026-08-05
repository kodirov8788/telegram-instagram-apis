import { describe, expect, it, beforeEach } from 'vitest';
import { TestQueueAdapter } from '../test-adapter';
import { PgmqQueueAdapter } from '../pgmq-adapter';
import { QueueValidationError } from '../errors';
import { DbClient } from '../../db';

describe('Queue Abstraction Layer Unit Tests', () => {
  const dummyClient: DbClient = {
    query: async () => ({ rows: [] }),
  };

  describe('Payload Validation (Shared contracts logic)', () => {
    const pgmq = new PgmqQueueAdapter();
    const fake = new TestQueueAdapter();

    it('denies non-object payloads', async () => {
      await expect(pgmq.send(dummyClient, 'inbound_events', null as any)).rejects.toThrow(QueueValidationError);
      await expect(fake.send(dummyClient, 'inbound_events', 'string-payload' as any)).rejects.toThrow(QueueValidationError);
    });

    it('denies incorrect version payloads', async () => {
      const badPayload = { v: 2, providerEventId: 'a3d65b16-43c3-4d40-84cf-cb5c5cc1baaa' };
      await expect(pgmq.send(dummyClient, 'inbound_events', badPayload as any)).rejects.toThrow(QueueValidationError);
      await expect(fake.send(dummyClient, 'inbound_events', badPayload as any)).rejects.toThrow(QueueValidationError);
    });

    it('denies extra properties on payload', async () => {
      const badPayload = { v: 1, providerEventId: 'a3d65b16-43c3-4d40-84cf-cb5c5cc1baaa', extra: 'field' };
      await expect(pgmq.send(dummyClient, 'inbound_events', badPayload as any)).rejects.toThrow(QueueValidationError);
      await expect(fake.send(dummyClient, 'inbound_events', badPayload as any)).rejects.toThrow(QueueValidationError);
    });

    it('denies invalid UUID format', async () => {
      const badPayload = { v: 1, providerEventId: 'not-a-uuid' };
      await expect(pgmq.send(dummyClient, 'inbound_events', badPayload as any)).rejects.toThrow(QueueValidationError);
      await expect(fake.send(dummyClient, 'inbound_events', badPayload as any)).rejects.toThrow(QueueValidationError);
    });

    it('denies mismatched keys for queues', async () => {
      const inboundPayloadForOutbound = { v: 1, providerEventId: 'a3d65b16-43c3-4d40-84cf-cb5c5cc1baaa' };
      await expect(pgmq.send(dummyClient, 'outbound_messages', inboundPayloadForOutbound as any)).rejects.toThrow(QueueValidationError);

      const outboundPayloadForInbound = { v: 1, outboundJobId: 'a3d65b16-43c3-4d40-84cf-cb5c5cc1baaa' };
      await expect(pgmq.send(dummyClient, 'inbound_events', outboundPayloadForInbound as any)).rejects.toThrow(QueueValidationError);
    });

    it('accepts correct payloads', async () => {
      const adapter = new TestQueueAdapter();
      const payload1 = { v: 1 as const, providerEventId: 'a3d65b16-43c3-4d40-84cf-cb5c5cc1baaa' };
      const id1 = await adapter.send(dummyClient, 'inbound_events', payload1);
      expect(id1).toBe(BigInt(1));

      const payload2 = { v: 1 as const, outboundJobId: 'b78a9cde-1234-5678-90ab-cdef12345678' };
      const id2 = await adapter.send(dummyClient, 'outbound_messages', payload2);
      expect(id2).toBe(BigInt(2));
    });
  });

  describe('TestQueueAdapter In-Memory Parity', () => {
    let adapter: TestQueueAdapter;

    beforeEach(() => {
      adapter = new TestQueueAdapter();
    });

    it('simulates basic send, read, delete cycle', async () => {
      const payload = { v: 1 as const, providerEventId: 'a3d65b16-43c3-4d40-84cf-cb5c5cc1baaa' };
      const id = await adapter.send(dummyClient, 'inbound_events', payload);
      expect(id).toBe(BigInt(1));

      const messages = await adapter.read(dummyClient, 'inbound_events', { limit: 1 });
      expect(messages.length).toBe(1);
      expect(messages[0].messageId).toBe(BigInt(1));
      expect(messages[0].readCount).toBe(1);
      expect(messages[0].payload).toEqual(payload);

      // Try reading again before visibility timeout expires: should be empty
      const empty = await adapter.read(dummyClient, 'inbound_events', { limit: 1 });
      expect(empty.length).toBe(0);

      // Delete message
      const deleted = await adapter.delete(dummyClient, 'inbound_events', BigInt(1));
      expect(deleted).toBe(true);

      // Re-deleting returns false
      const deletedAgain = await adapter.delete(dummyClient, 'inbound_events', BigInt(1));
      expect(deletedAgain).toBe(false);
    });

    it('simulates visibility timeout and reappearance', async () => {
      let mockTime = new Date();
      const adapter = new TestQueueAdapter(() => mockTime);
      const payload = { v: 1 as const, providerEventId: 'a3d65b16-43c3-4d40-84cf-cb5c5cc1baaa' };
      await adapter.send(dummyClient, 'inbound_events', payload);

      // Read with a visibility timeout of 10 seconds
      const read1 = await adapter.read(dummyClient, 'inbound_events', { visibilityTimeout: 10, limit: 1 });
      expect(read1.length).toBe(1);
      expect(read1[0].readCount).toBe(1);

      // Should be hidden immediately after read
      const readEmpty = await adapter.read(dummyClient, 'inbound_events', { visibilityTimeout: 10, limit: 1 });
      expect(readEmpty.length).toBe(0);

      // Advance mock time by 11 seconds (timeout is 10s)
      mockTime = new Date(mockTime.getTime() + 11 * 1000);

      // Should be immediately visible again
      const read2 = await adapter.read(dummyClient, 'inbound_events', { visibilityTimeout: 120, limit: 1 });
      expect(read2.length).toBe(1);
      expect(read2[0].readCount).toBe(2);

      // Now it should be hidden
      const read3 = await adapter.read(dummyClient, 'inbound_events', { limit: 1 });
      expect(read3.length).toBe(0);
    });

    it('simulates archive preservation', async () => {
      const payload = { v: 1 as const, providerEventId: 'a3d65b16-43c3-4d40-84cf-cb5c5cc1baaa' };
      await adapter.send(dummyClient, 'inbound_events', payload);

      const archived = await adapter.archive(dummyClient, 'inbound_events', BigInt(1));
      expect(archived).toBe(true);

      // Re-archiving returns false
      const archivedAgain = await adapter.archive(dummyClient, 'inbound_events', BigInt(1));
      expect(archivedAgain).toBe(false);

      // Cannot read from queue
      const read = await adapter.read(dummyClient, 'inbound_events', { limit: 1 });
      expect(read.length).toBe(0);

      // But it is preserved in the internal messages array as archived
      const rawMsgs = adapter.getMessages();
      expect(rawMsgs[0].archived).toBe(true);
      expect(rawMsgs[0].deleted).toBe(false);
    });

    it('enforces input validations', async () => {
      await expect(adapter.read(dummyClient, 'inbound_events', { limit: 0 })).rejects.toThrow(QueueValidationError);
      await expect(adapter.read(dummyClient, 'inbound_events', { limit: 6 })).rejects.toThrow(QueueValidationError);
      await expect(adapter.read(dummyClient, 'inbound_events', { visibilityTimeout: 0 })).rejects.toThrow(QueueValidationError);
      await expect(adapter.read(dummyClient, 'inbound_events', { visibilityTimeout: -5 })).rejects.toThrow(QueueValidationError);
      await expect(adapter.read(dummyClient, 'inbound_events', { visibilityTimeout: 1.5 })).rejects.toThrow(QueueValidationError);
      await expect(adapter.send(dummyClient, 'inbound_events', { v: 1, providerEventId: 'a3d65b16-43c3-4d40-84cf-cb5c5cc1baaa' }, -1)).rejects.toThrow(QueueValidationError);
      await expect(adapter.send(dummyClient, 'inbound_events', { v: 1, providerEventId: 'a3d65b16-43c3-4d40-84cf-cb5c5cc1baaa' }, 1.5)).rejects.toThrow(QueueValidationError);
    });
  });
});
