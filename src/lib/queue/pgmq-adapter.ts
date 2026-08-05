import { QueueAdapter, QueueName, QueuePayload, QueueMessage, validatePayload } from './contracts';
import { DbClient } from '../db';
import { translateDatabaseError, QueueValidationError } from './errors';

export class PgmqQueueAdapter implements QueueAdapter {
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

    try {
      const res = await client.query(
        'SELECT ydeck_queue.send($1, $2::jsonb, $3) AS msg_id',
        [queue, JSON.stringify(payload), delay]
      );
      if (!res.rows || res.rows.length === 0) {
        throw new Error('No row returned from ydeck_queue.send');
      }
      return BigInt(res.rows[0].msg_id);
    } catch (error) {
      throw translateDatabaseError(error);
    }
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

    try {
      const res = await client.query(
        'SELECT msg_id, read_ct, enqueued_at, vt, message FROM ydeck_queue.read($1, $2, $3)',
        [queue, vt, limit]
      );

      const messages: QueueMessage<T>[] = [];

      for (const row of res.rows) {
        const payload = row.message;

        try {
          validatePayload(queue, payload);
        } catch (err: any) {
          throw new QueueValidationError(`Malformed message payload: ${err.message}`);
        }

        messages.push({
          messageId: BigInt(row.msg_id),
          readCount: Number(row.read_ct),
          enqueuedAt: new Date(row.enqueued_at),
          visibleAt: new Date(row.vt),
          lastReadAt: null,
          payload: payload as QueuePayload<T>,
        });
      }

      return messages;
    } catch (error) {
      throw translateDatabaseError(error);
    }
  }

  public async delete(
    client: DbClient,
    queue: QueueName,
    id: bigint
  ): Promise<boolean> {
    if (queue !== 'inbound_events' && queue !== 'outbound_messages') {
      throw new QueueValidationError(`Invalid queue name: ${queue}`);
    }

    try {
      const res = await client.query(
        'SELECT ydeck_queue.delete($1, $2::bigint) AS success',
        [queue, id.toString()]
      );
      if (!res.rows || res.rows.length === 0) {
        return false;
      }
      return Boolean(res.rows[0].success);
    } catch (error) {
      throw translateDatabaseError(error);
    }
  }

  public async archive(
    client: DbClient,
    queue: QueueName,
    id: bigint
  ): Promise<boolean> {
    if (queue !== 'inbound_events' && queue !== 'outbound_messages') {
      throw new QueueValidationError(`Invalid queue name: ${queue}`);
    }

    try {
      const res = await client.query(
        'SELECT ydeck_queue.archive($1, $2::bigint) AS success',
        [queue, id.toString()]
      );
      if (!res.rows || res.rows.length === 0) {
        return false;
      }
      return Boolean(res.rows[0].success);
    } catch (error) {
      throw translateDatabaseError(error);
    }
  }
}
