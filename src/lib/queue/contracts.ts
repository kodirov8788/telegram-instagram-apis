import { DbClient } from '../db';
import { QueueValidationError } from './errors';

export type QueueName = 'inbound_events' | 'outbound_messages';

export interface InboundPayload {
  v: 1;
  providerEventId: string;
}

export interface OutboundPayload {
  v: 1;
  outboundMessageId: string;
}

export type QueuePayload<T extends QueueName> =
  T extends 'inbound_events' ? InboundPayload : OutboundPayload;

export interface QueueMessage<T extends QueueName> {
  messageId: bigint;
  readCount: number;
  enqueuedAt: Date;
  visibleAt: Date;
  lastReadAt?: Date | null;
  payload: QueuePayload<T>;
}

export interface QueueAdapter {
  send<T extends QueueName>(
    client: DbClient,
    queue: T,
    payload: QueuePayload<T>,
    delay?: number
  ): Promise<bigint>;

  read<T extends QueueName>(
    client: DbClient,
    queue: T,
    options?: { visibilityTimeout?: number; limit?: number }
  ): Promise<QueueMessage<T>[]>;

  delete(
    client: DbClient,
    queue: QueueName,
    id: bigint
  ): Promise<boolean>;

  archive(
    client: DbClient,
    queue: QueueName,
    id: bigint
  ): Promise<boolean>;
}

export function validatePayload<T extends QueueName>(queue: T, payload: any): asserts payload is QueuePayload<T> {
  if (!payload || typeof payload !== 'object') {
    throw new QueueValidationError('Payload must be a non-null object');
  }
  const keys = Object.keys(payload);
  if (keys.length !== 2) {
    throw new QueueValidationError(`Payload must have exactly 2 properties, got keys: ${keys.join(', ')}`);
  }
  if (payload.v !== 1) {
    throw new QueueValidationError(`Payload version must be 1, got: ${payload.v}`);
  }

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  if (queue === 'inbound_events') {
    if (!('providerEventId' in payload)) {
      throw new QueueValidationError('Inbound payload must contain providerEventId');
    }
    if (typeof payload.providerEventId !== 'string' || !uuidRegex.test(payload.providerEventId)) {
      throw new QueueValidationError('providerEventId must be a valid UUID');
    }
  } else if (queue === 'outbound_messages') {
    if (!('outboundMessageId' in payload)) {
      throw new QueueValidationError('Outbound payload must contain outboundMessageId');
    }
    if (typeof payload.outboundMessageId !== 'string' || !uuidRegex.test(payload.outboundMessageId)) {
      throw new QueueValidationError('outboundMessageId must be a valid UUID');
    }
  } else {
    throw new QueueValidationError(`Unknown queue: ${queue}`);
  }
}
