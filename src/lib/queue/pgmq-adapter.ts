import type { DbClient } from '../db';
import { QueueAdapter, QueueName, QueuePayload, QueueMessage, validatePayload, validateOutboundPayload } from './contracts';
import { QueueValidationError } from './errors';

const KNOWN_QUEUES: readonly QueueName[] = ['inbound_events', 'outbound_jobs'];

function assertKnownQueue(queue: QueueName): void {
  if (!KNOWN_QUEUES.includes(queue)) throw new QueueValidationError(`Unknown queue: ${queue}`);
}

/** Thin wrapper over the `ydeck_queue.*` SQL functions (see migrations 010, 016). */
export class PgmqQueueAdapter implements QueueAdapter {
  async send(client: DbClient, queue: QueueName, payload: QueuePayload, delaySeconds = 0): Promise<bigint> {
    assertKnownQueue(queue);
    if (queue === 'inbound_events') {
      validatePayload(payload);
    } else {
      validateOutboundPayload(payload);
    }
    if (!Number.isInteger(delaySeconds) || delaySeconds < 0) {
      throw new QueueValidationError('delaySeconds must be an integer >= 0');
    }

    const res = await client.query('SELECT ydeck_queue.send($1, $2::jsonb, $3) AS msg_id', [
      queue,
      JSON.stringify(payload),
      delaySeconds,
    ]);
    return BigInt(res.rows[0].msg_id);
  }

  async read(
    client: DbClient,
    queue: QueueName,
    options?: { visibilityTimeout?: number; limit?: number }
  ): Promise<QueueMessage[]> {
    assertKnownQueue(queue);
    const visibilityTimeout = options?.visibilityTimeout ?? 900;
    const limit = options?.limit ?? 5;
    if (!Number.isInteger(visibilityTimeout) || visibilityTimeout < 1) {
      throw new QueueValidationError('visibilityTimeout must be an integer >= 1');
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 5) {
      throw new QueueValidationError('limit must be an integer between 1 and 5');
    }

    const res = await client.query('SELECT msg_id, read_ct, enqueued_at, vt, message FROM ydeck_queue.read($1, $2, $3)', [
      queue,
      visibilityTimeout,
      limit,
    ]);

    return res.rows.map((row: any) => ({
      messageId: BigInt(row.msg_id),
      readCount: Number(row.read_ct),
      enqueuedAt: new Date(row.enqueued_at),
      visibleAt: new Date(row.vt),
      payload: row.message,
    }));
  }

  async delete(client: DbClient, queue: QueueName, id: bigint): Promise<boolean> {
    assertKnownQueue(queue);
    const res = await client.query('SELECT ydeck_queue.delete($1, $2::bigint) AS success', [queue, id.toString()]);
    return Boolean(res.rows[0]?.success);
  }

  async archive(client: DbClient, queue: QueueName, id: bigint): Promise<boolean> {
    assertKnownQueue(queue);
    const res = await client.query('SELECT ydeck_queue.archive($1, $2::bigint) AS success', [queue, id.toString()]);
    return Boolean(res.rows[0]?.success);
  }
}
