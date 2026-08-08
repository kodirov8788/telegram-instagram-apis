import { queueWorkerTransaction } from './transaction';
import { PgmqQueueAdapter } from '../queue/pgmq-adapter';
import { QueueAdapter, QueueName, QueuePayload, extractPayloadId } from '../queue/contracts';
import { RetryableWorkError } from './errors';

export interface WorkerRuntimeOptions {
  queue: QueueName;
  /** Receives the id extracted from the queue's payload (providerEventId for inbound_events, outboundJobId for outbound_jobs). */
  process: (payloadId: string) => Promise<unknown>;
  signal?: AbortSignal;
  visibilityTimeout?: number;
  maxAttempts?: number;
  pollIntervalMs?: number;
  logger?: Pick<Console, 'info' | 'error'>;
  adapter?: QueueAdapter;
  /**
   * Extracts and validates the payload's id for `options.queue`. Defaults
   * to `extractPayloadId(options.queue, payload)`, which already validates
   * shape per-queue (see contracts.ts) — override only for tests/mocks.
   */
  extractId?: (payload: unknown) => string;
}

/**
 * Reads one batch, processes each message, and resolves it:
 *   - success                       -> delete
 *   - RetryableWorkError(delayMs)   -> atomically re-enqueue with delay, delete original
 *   - malformed payload             -> archive (never blocks the rest of the batch)
 *   - other error, under maxAttempts-> leave in place for pgmq's own visibility-timeout redelivery
 *   - other error, at maxAttempts   -> archive (permanent failure, inspectable via pgmq's archive table)
 * Returns the batch size processed (0 means the caller should back off before polling again).
 */
export async function processWorkerBatch(options: WorkerRuntimeOptions): Promise<number> {
  const adapter = options.adapter ?? new PgmqQueueAdapter();
  const maxAttempts = options.maxAttempts ?? 8;
  const extractId = options.extractId ?? ((payload: unknown) => extractPayloadId(options.queue, payload));
  const messages = await queueWorkerTransaction(client =>
    adapter.read(client, options.queue, { visibilityTimeout: options.visibilityTimeout ?? 900, limit: 5 })
  );

  await Promise.all(
    messages.map(async message => {
      let payloadId: string;
      try {
        payloadId = extractId(message.payload);
      } catch {
        await queueWorkerTransaction(client => adapter.archive(client, options.queue, message.messageId));
        options.logger?.error('Archived malformed queue message', { queue: options.queue, messageId: message.messageId.toString() });
        return;
      }

      try {
        await options.process(payloadId);
        await queueWorkerTransaction(client => adapter.delete(client, options.queue, message.messageId));
      } catch (error) {
        if (error instanceof RetryableWorkError) {
          await queueWorkerTransaction(async client => {
            await adapter.send(client, options.queue, message.payload as QueuePayload, Math.ceil(error.delayMs / 1_000));
            await adapter.delete(client, options.queue, message.messageId);
          });
          return;
        }
        if (message.readCount >= maxAttempts) {
          await queueWorkerTransaction(client => adapter.archive(client, options.queue, message.messageId));
          options.logger?.error('Archived queue message after maximum attempts', {
            queue: options.queue,
            messageId: message.messageId.toString(),
            attempts: message.readCount,
          });
        } else {
          options.logger?.error('Queue message processing failed; leaving for redelivery', {
            queue: options.queue,
            messageId: message.messageId.toString(),
            attempts: message.readCount,
          });
        }
      }
    })
  );

  return messages.length;
}

/** Long-running poll loop; exits when `signal` aborts (used for SIGTERM/SIGINT graceful shutdown). */
export async function runWorker(options: WorkerRuntimeOptions): Promise<void> {
  const waitMs = options.pollIntervalMs ?? 1_000;
  while (!options.signal?.aborted) {
    const count = await processWorkerBatch(options);
    if (count === 0 && !options.signal?.aborted) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, waitMs);
        options.signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
      });
    }
  }
  options.logger?.info('Worker stopped', { queue: options.queue });
}
