import { queueWorkerTransaction } from '@/lib/db';
import { PgmqQueueAdapter } from '@/lib/queue/pgmq-adapter';
import { QueueAdapter, QueueName, QueuePayload, validatePayload } from '@/lib/queue/contracts';
import { RetryableWorkError } from '@/lib/workers/errors';

export interface WorkerRuntimeOptions<T extends QueueName> {
  queue: T;
  process: (id: string) => Promise<unknown>;
  signal?: AbortSignal;
  visibilityTimeout?: number;
  maxAttempts?: number;
  pollIntervalMs?: number;
  logger?: Pick<Console, 'info' | 'error'>;
  adapter?: QueueAdapter;
}

const idFromPayload = <T extends QueueName>(queue: T, payload: QueuePayload<T>): string =>
  queue === 'inbound_events'
    ? (payload as QueuePayload<'inbound_events'>).providerEventId
    : (payload as QueuePayload<'outbound_messages'>).outboundJobId;

export async function processWorkerBatch<T extends QueueName>(options: WorkerRuntimeOptions<T>): Promise<number> {
  const adapter = options.adapter ?? new PgmqQueueAdapter();
  const maxAttempts = options.maxAttempts ?? 8;
  const messages = await queueWorkerTransaction(client => adapter.read(client, options.queue, {
    visibilityTimeout: options.visibilityTimeout ?? 900,
    limit: 5,
  }));

  await Promise.all(messages.map(async message => {
    let id: string;
    try {
      validatePayload(options.queue, message.payload);
      id = idFromPayload(options.queue, message.payload);
    } catch {
      await queueWorkerTransaction(client => adapter.archive(client, options.queue, message.messageId));
      options.logger?.error('Archived malformed queue message', { queue: options.queue, messageId: message.messageId.toString() });
      return;
    }

    try {
      await options.process(id);
      await queueWorkerTransaction(client => adapter.delete(client, options.queue, message.messageId));
    } catch (error) {
      if (error instanceof RetryableWorkError) {
        await queueWorkerTransaction(async client => {
          await adapter.send(client, options.queue, message.payload as QueuePayload<T>, Math.ceil(error.delayMs / 1_000));
          await adapter.delete(client, options.queue, message.messageId);
        });
        return;
      }
      if (message.readCount >= maxAttempts) {
        await queueWorkerTransaction(client => adapter.archive(client, options.queue, message.messageId));
        options.logger?.error('Archived queue message after maximum attempts', { queue: options.queue, messageId: message.messageId.toString(), attempts: message.readCount });
      } else {
        options.logger?.error('Queue message processing failed', { queue: options.queue, messageId: message.messageId.toString(), attempts: message.readCount });
      }
    }
  }));
  return messages.length;
}

export async function runWorker(options: WorkerRuntimeOptions<QueueName>): Promise<void> {
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
