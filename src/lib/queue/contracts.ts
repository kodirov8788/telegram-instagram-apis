import type { DbClient } from '../db';
import { QueueValidationError } from './errors';

/**
 * Scope: a single durable queue, `inbound_events`. The payload is
 * deliberately ID-only — never the message content itself — so the queue
 * never holds customer data at rest and a payload can't go stale relative
 * to the provider_events row it points at.
 */
export type QueueName = 'inbound_events';

export interface InboundPayload {
  v: 1;
  providerEventId: string;
}

export type QueuePayload = InboundPayload;

export interface QueueMessage {
  messageId: bigint;
  readCount: number;
  enqueuedAt: Date;
  visibleAt: Date;
  /** Untrusted until validatePayload is called by the consumer. */
  payload: unknown;
}

export interface QueueAdapter {
  send(client: DbClient, queue: QueueName, payload: QueuePayload, delaySeconds?: number): Promise<bigint>;
  read(client: DbClient, queue: QueueName, options?: { visibilityTimeout?: number; limit?: number }): Promise<QueueMessage[]>;
  delete(client: DbClient, queue: QueueName, id: bigint): Promise<boolean>;
  archive(client: DbClient, queue: QueueName, id: bigint): Promise<boolean>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validatePayload(payload: unknown): asserts payload is QueuePayload {
  if (!payload || typeof payload !== 'object') {
    throw new QueueValidationError('Payload must be a non-null object');
  }
  const obj = payload as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length !== 2) {
    throw new QueueValidationError(`Payload must have exactly 2 properties, got: ${keys.join(', ')}`);
  }
  if (obj.v !== 1) {
    throw new QueueValidationError(`Payload version must be 1, got: ${String(obj.v)}`);
  }
  if (typeof obj.providerEventId !== 'string' || !UUID_RE.test(obj.providerEventId)) {
    throw new QueueValidationError('providerEventId must be a valid UUID');
  }
}
