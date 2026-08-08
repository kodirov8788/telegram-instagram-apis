import type { DbClient } from '../db';
import { QueueValidationError } from './errors';

/**
 * Scope: two durable queues, `inbound_events` and `outbound_jobs`. Every
 * payload is deliberately ID-only — never message content, workspace ids,
 * or credentials — so the queue never holds customer data or secrets at
 * rest and a payload can't go stale relative to the row it points at.
 */
export type QueueName = 'inbound_events' | 'outbound_jobs';

export interface InboundPayload {
  v: 1;
  providerEventId: string;
}

export interface OutboundPayload {
  v: 1;
  outboundJobId: string;
}

export type QueuePayload = InboundPayload | OutboundPayload;

export interface QueueMessage {
  messageId: bigint;
  readCount: number;
  enqueuedAt: Date;
  visibleAt: Date;
  /** Untrusted until validatePayload (or a queue-specific validator) is called by the consumer. */
  payload: unknown;
}

export interface QueueAdapter {
  send(client: DbClient, queue: QueueName, payload: QueuePayload, delaySeconds?: number): Promise<bigint>;
  read(client: DbClient, queue: QueueName, options?: { visibilityTimeout?: number; limit?: number }): Promise<QueueMessage[]>;
  delete(client: DbClient, queue: QueueName, id: bigint): Promise<boolean>;
  archive(client: DbClient, queue: QueueName, id: bigint): Promise<boolean>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertVersionedIdShape(payload: unknown, idKey: string): asserts payload is Record<string, unknown> {
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
  if (typeof obj[idKey] !== 'string' || !UUID_RE.test(obj[idKey] as string)) {
    throw new QueueValidationError(`${idKey} must be a valid UUID`);
  }
}

/** Validates the `inbound_events` payload shape. Behavior-preserving alias of the pre-#46 `validatePayload`. */
export function validatePayload(payload: unknown): asserts payload is InboundPayload {
  assertVersionedIdShape(payload, 'providerEventId');
}

/** Validates the `outbound_jobs` payload shape. */
export function validateOutboundPayload(payload: unknown): asserts payload is OutboundPayload {
  assertVersionedIdShape(payload, 'outboundJobId');
}

/** Returns the right validator for a given queue, so callers can generalize without an if/else on queue name. */
export function payloadValidatorFor(queue: QueueName): (payload: unknown) => asserts payload is QueuePayload {
  return queue === 'inbound_events'
    ? (validatePayload as (payload: unknown) => asserts payload is QueuePayload)
    : (validateOutboundPayload as (payload: unknown) => asserts payload is QueuePayload);
}

/** Extracts the id field a given queue's payload carries, after validating its shape. */
export function extractPayloadId(queue: QueueName, payload: unknown): string {
  if (queue === 'inbound_events') {
    validatePayload(payload);
    return payload.providerEventId;
  }
  validateOutboundPayload(payload);
  return payload.outboundJobId;
}
