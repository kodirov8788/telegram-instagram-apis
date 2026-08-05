import { QueueAdapter, QueueName, QueuePayload, QueueMessage, validatePayload } from './contracts';
import { DbClient } from '../db';
import { QueueValidationError } from './errors';

interface FakeMessage {
  id: bigint;
  queue: QueueName;
  payload: any;
  enqueuedAt: Date;
  visibleAt: Date;
  readCount: number;
  archived: boolean;
  deleted: boolean;
}

export class TestQueueAdapter implements QueueAdapter {
  private messages: FakeMessage[] = [];
  private nextId = BigInt(1);
  private timeProvider: () => Date;

  constructor(timeProvider?: () => Date) {
    this.timeProvider = timeProvider || (() => new Date());
  }

  public async send<T extends QueueName>(
    client: DbClient,
    queue: T,
    payload: QueuePayload<T>,
    delay: number = 0
  ): Promise<bigint> {
    try {
      validatePayload(queue, payload);
    } catch (err: any) {
      if (err instanceof QueueValidationError) throw err;
      throw new QueueValidationError(err.message || 'Payload validation failed');
    }

    if (queue !== 'inbound_events' && queue !== 'outbound_messages') {
      throw new QueueValidationError(`Invalid queue name: ${queue}`);
    }

    if (!Number.isInteger(delay) || delay < 0) {
      throw new QueueValidationError('Delay must be an integer >= 0');
    }

    const id = this.nextId++;
    const now = this.timeProvider();
    const visibleAt = new Date(now.getTime() + delay * 1000);

    this.messages.push({
      id,
      queue,
      payload: JSON.parse(JSON.stringify(payload)),
      enqueuedAt: now,
      visibleAt,
      readCount: 0,
      archived: false,
      deleted: false,
    });

    return id;
  }

  public async read<T extends QueueName>(
    client: DbClient,
    queue: T,
    options?: { visibilityTimeout?: number; limit?: number }
  ): Promise<QueueMessage<T>[]> {
    if (queue !== 'inbound_events' && queue !== 'outbound_messages') {
      throw new QueueValidationError(`Invalid queue name: ${queue}`);
    }

    const vt = options?.visibilityTimeout ?? 120;
    const limit = options?.limit ?? 5;

    if (!Number.isInteger(vt) || vt < 1) {
      throw new QueueValidationError('Visibility timeout must be an integer >= 1');
    }

    if (!Number.isInteger(limit) || limit < 1 || limit > 5) {
      throw new QueueValidationError('Batch limit must be an integer between 1 and 5');
    }

    const now = this.timeProvider();
    const available = this.messages
      .filter(m => m.queue === queue && !m.deleted && !m.archived && m.visibleAt <= now)
      .slice(0, limit);

    for (const msg of available) {
      msg.readCount++;
      msg.visibleAt = new Date(now.getTime() + vt * 1000);
    }

    return available.map(m => ({
      messageId: m.id,
      readCount: m.readCount,
      enqueuedAt: m.enqueuedAt,
      visibleAt: m.visibleAt,
      lastReadAt: null,
      payload: m.payload,
    }));
  }

  public async delete(
    client: DbClient,
    queue: QueueName,
    id: bigint
  ): Promise<boolean> {
    if (queue !== 'inbound_events' && queue !== 'outbound_messages') {
      throw new QueueValidationError(`Invalid queue name: ${queue}`);
    }

    const msg = this.messages.find(m => m.queue === queue && m.id === id && !m.deleted && !m.archived);
    if (!msg) return false;
    msg.deleted = true;
    return true;
  }

  public async archive(
    client: DbClient,
    queue: QueueName,
    id: bigint
  ): Promise<boolean> {
    if (queue !== 'inbound_events' && queue !== 'outbound_messages') {
      throw new QueueValidationError(`Invalid queue name: ${queue}`);
    }

    const msg = this.messages.find(m => m.queue === queue && m.id === id && !m.deleted && !m.archived);
    if (!msg) return false;
    msg.archived = true;
    return true;
  }

  public getMessages(): FakeMessage[] {
    return this.messages;
  }

  public clear(): void {
    this.messages = [];
    this.nextId = BigInt(1);
  }
}
