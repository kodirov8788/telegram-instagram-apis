import { runtimeRoleTransaction } from '@/lib/db';
import { PgmqQueueAdapter } from '@/lib/queue/pgmq-adapter';
import { QueueAdapter, QueueName, QueuePayload, validatePayload } from '@/lib/queue/contracts';

export interface WorkerRuntimeOptions<T extends QueueName> {
  queue: T;
  process: (id: string) => Promise<void>;
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
  const maxAttempts = options.maxAttempts ?? 5;
  const messages = await runtimeRoleTransaction(client => adapter.read(client, options.queue, {
    visibilityTimeout: options.visibilityTimeout ?? 120,
    limit: 5,
  }));

  await Promise.all(messages.map(async message => {
    let id: string;
    try {
      validatePayload(options.queue, message.payload);
      id = idFromPayload(options.queue, message.payload);
    } catch {
      await runtimeRoleTransaction(client => adapter.archive(client, options.queue, message.messageId));
      options.logger?.error('Archived malformed queue message', { queue: options.queue, messageId: message.messageId.toString() });
      return;
    }

    try {
      await options.process(id);
      await runtimeRoleTransaction(client => adapter.delete(client, options.queue, message.messageId));
    } catch {
      if (message.readCount >= maxAttempts) {
        await runtimeRoleTransaction(client => adapter.archive(client, options.queue, message.messageId));
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
