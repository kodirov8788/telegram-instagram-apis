import type { DbClient } from '../db';
import { QueueAdapter, QueueName, QueuePayload, QueueMessage, validatePayload, validateOutboundPayload } from './contracts';
import { QueueValidationError } from './errors';

interface StoredMessage {
  id: bigint;
  queue: QueueName;
  payload: unknown;
  enqueuedAt: Date;
  visibleAt: Date;
  readCount: number;
  archived: boolean;
  deleted: boolean;
}

/**
 * In-memory stand-in for PgmqQueueAdapter, for unit tests that need real
 * visibility-timeout/read-count semantics without a live Postgres+pgmq
 * instance. Behavior intentionally mirrors the SQL wrapper's contract
 * (batch limit 1-5, visibilityTimeout >= 1, delaySeconds >= 0 integer).
 */
export class TestQueueAdapter implements QueueAdapter {
  private messages: StoredMessage[] = [];
  private nextId = BigInt(1);

  constructor(private now: () => Date = () => new Date()) {}

  getMessages(): StoredMessage[] {
    return this.messages;
  }

  async send(_client: DbClient, queue: QueueName, payload: QueuePayload, delaySeconds = 0): Promise<bigint> {
    if (queue !== 'inbound_events' && queue !== 'outbound_jobs') {
      throw new QueueValidationError(`Unknown queue: ${queue}`);
    }
    if (queue === 'inbound_events') {
      validatePayload(payload);
    } else {
      validateOutboundPayload(payload);
    }
    if (!Number.isInteger(delaySeconds) || delaySeconds < 0) {
      throw new QueueValidationError('delaySeconds must be an integer >= 0');
    }
    const id = this.nextId++;
    const enqueuedAt = this.now();
    this.messages.push({
      id,
      queue,
      payload,
      enqueuedAt,
      visibleAt: new Date(enqueuedAt.getTime() + delaySeconds * 1000),
      readCount: 0,
      archived: false,
      deleted: false,
    });
    return id;
  }

  async read(_client: DbClient, queue: QueueName, options?: { visibilityTimeout?: number; limit?: number }): Promise<QueueMessage[]> {
    const visibilityTimeout = options?.visibilityTimeout ?? 900;
    const limit = options?.limit ?? 5;
    if (!Number.isInteger(visibilityTimeout) || visibilityTimeout < 1) {
      throw new QueueValidationError('visibilityTimeout must be an integer >= 1');
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 5) {
      throw new QueueValidationError('limit must be an integer between 1 and 5');
    }

    const now = this.now();
    const eligible = this.messages
      .filter(m => m.queue === queue && !m.deleted && !m.archived && m.visibleAt <= now)
      .slice(0, limit);

    for (const m of eligible) {
      m.readCount += 1;
      m.visibleAt = new Date(now.getTime() + visibilityTimeout * 1000);
    }

    return eligible.map(m => ({ messageId: m.id, readCount: m.readCount, enqueuedAt: m.enqueuedAt, visibleAt: m.visibleAt, payload: m.payload }));
  }

  async delete(_client: DbClient, _queue: QueueName, id: bigint): Promise<boolean> {
    const m = this.messages.find(m => m.id === id && !m.deleted);
    if (!m) return false;
    m.deleted = true;
    return true;
  }

  async archive(_client: DbClient, _queue: QueueName, id: bigint): Promise<boolean> {
    const m = this.messages.find(m => m.id === id && !m.archived);
    if (!m) return false;
    m.archived = true;
    return true;
  }
}
