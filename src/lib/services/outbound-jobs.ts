import { query } from '../db';

export type OutboundChannel = 'telegram' | 'instagram';

export type OutboundJobStatus =
  | 'pending'
  | 'processing'
  | 'sent'
  | 'retryable_failed'
  | 'permanent_failed'
  | 'ambiguous';

export interface OutboundJob {
  id: string;
  workspaceId: string;
  connectionId: string;
  channel: OutboundChannel;
  messageId: string;
  recipientId: string;
  content: string;
  status: OutboundJobStatus;
  attempts: number;
  providerMessageId: string | null;
  lastError: string | null;
  nextAttemptAt: Date;
  sentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateOutboundJobInput {
  workspaceId: string;
  connectionId: string;
  channel: OutboundChannel;
  messageId: string;
  recipientId: string;
  content: string;
}

/**
 * Thrown by `createJob` when the target message already has an active
 * (pending/processing/retryable_failed) job — enforced at the DB layer by
 * `outbound_jobs_message_active_unique` (migration 013), this is the
 * application-facing signal for that constraint violation.
 */
export class DuplicateActiveJobError extends Error {
  constructor(readonly messageId: string) {
    super(`An active outbound job already exists for message ${messageId}`);
    this.name = 'DuplicateActiveJobError';
  }
}

/**
 * Thrown when a status transition is attempted against a job that is not
 * in the required source state (e.g. marking a job `sent` when it was
 * never claimed into `processing`) — the atomic conditional UPDATE found
 * no matching row.
 */
export class InvalidJobTransitionError extends Error {
  constructor(readonly jobId: string, readonly attemptedTransition: string) {
    super(`Job ${jobId} is not in a state that allows transition: ${attemptedTransition}`);
    this.name = 'InvalidJobTransitionError';
  }
}

const UNIQUE_VIOLATION = '23505';

function mapRow(row: any): OutboundJob {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    connectionId: row.connection_id,
    channel: row.channel,
    messageId: row.message_id,
    recipientId: row.recipient_id,
    content: row.content,
    status: row.status,
    attempts: row.attempts,
    providerMessageId: row.provider_message_id,
    lastError: row.last_error,
    nextAttemptAt: row.next_attempt_at,
    sentAt: row.sent_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Persists outbound send intent as a `pending` row BEFORE any provider
 * delivery attempt is made — the durability guarantee this table exists
 * for. Callers (the future #46 worker/dispatcher) must create this row
 * first, then only ever act on the provider from within a claimed job.
 *
 * One message can have at most one active job at a time; a second attempt
 * to create one raises `DuplicateActiveJobError` instead of silently
 * succeeding or double-enqueuing a send.
 */
export async function createJob(input: CreateOutboundJobInput): Promise<OutboundJob> {
  try {
    const result = await query(
      `INSERT INTO outbound_jobs (workspace_id, connection_id, channel, message_id, recipient_id, content)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [input.workspaceId, input.connectionId, input.channel, input.messageId, input.recipientId, input.content]
    );
    return mapRow(result.rows[0]);
  } catch (error: any) {
    if (error?.code === UNIQUE_VIOLATION) {
      throw new DuplicateActiveJobError(input.messageId);
    }
    throw error;
  }
}

/**
 * Atomically claims the next due job and marks it `processing`. Uses the
 * same conditional-UPDATE...RETURNING pattern as `provider_events`'s claim
 * (src/lib/workers/processors/inbound.ts): two workers racing on the same
 * row will only ever have one succeed, because the UPDATE's WHERE clause
 * re-checks status/timing at commit time. A job stuck in `processing` for
 * over 10 minutes (a crashed worker's stale claim) is also reclaimable.
 *
 * Returns null if there is no claimable work right now.
 */
export async function claimNextJob(): Promise<OutboundJob | null> {
  const result = await query(
    `UPDATE outbound_jobs
     SET status = 'processing', attempts = attempts + 1, updated_at = NOW()
     WHERE id = (
       SELECT id FROM outbound_jobs
       WHERE (status IN ('pending', 'retryable_failed') AND next_attempt_at <= NOW())
          OR (status = 'processing' AND updated_at < NOW() - INTERVAL '10 minutes')
       ORDER BY next_attempt_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING *`
  );
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/** Marks a `processing` job `sent`. Rejects the transition from any other state. */
export async function markSent(jobId: string, providerMessageId: string): Promise<OutboundJob> {
  const result = await query(
    `UPDATE outbound_jobs
     SET status = 'sent', provider_message_id = $2, last_error = NULL, sent_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND status = 'processing'
     RETURNING *`,
    [jobId, providerMessageId]
  );
  const row = result.rows[0];
  if (!row) throw new InvalidJobTransitionError(jobId, 'markSent');
  return mapRow(row);
}

/**
 * Marks a `processing` job `retryable_failed` and schedules `next_attempt_at`
 * `delayMs` in the future. Rejects the transition from any other state.
 */
export async function markRetryableFailed(jobId: string, error: string, delayMs: number): Promise<OutboundJob> {
  const result = await query(
    `UPDATE outbound_jobs
     SET status = 'retryable_failed', last_error = $2, next_attempt_at = NOW() + ($3 * INTERVAL '1 millisecond'), updated_at = NOW()
     WHERE id = $1 AND status = 'processing'
     RETURNING *`,
    [jobId, error.slice(0, 500), delayMs]
  );
  const row = result.rows[0];
  if (!row) throw new InvalidJobTransitionError(jobId, 'markRetryableFailed');
  return mapRow(row);
}

/** Marks a `processing` job `permanent_failed` (terminal). Rejects the transition from any other state. */
export async function markPermanentFailed(jobId: string, error: string): Promise<OutboundJob> {
  const result = await query(
    `UPDATE outbound_jobs
     SET status = 'permanent_failed', last_error = $2, updated_at = NOW()
     WHERE id = $1 AND status = 'processing'
     RETURNING *`,
    [jobId, error.slice(0, 500)]
  );
  const row = result.rows[0];
  if (!row) throw new InvalidJobTransitionError(jobId, 'markPermanentFailed');
  return mapRow(row);
}

/**
 * Marks a `processing` job `ambiguous` — the provider call may have
 * succeeded or failed and its outcome is unknown (e.g. a network timeout
 * after dispatch, before a response arrived). Terminal from this table's
 * perspective: automatic retry would risk a duplicate send, so recovering
 * from `ambiguous` requires an explicit decision by the consumer (#46),
 * not a state this service will auto-transition out of.
 */
export async function markAmbiguous(jobId: string, error: string): Promise<OutboundJob> {
  const result = await query(
    `UPDATE outbound_jobs
     SET status = 'ambiguous', last_error = $2, updated_at = NOW()
     WHERE id = $1 AND status = 'processing'
     RETURNING *`,
    [jobId, error.slice(0, 500)]
  );
  const row = result.rows[0];
  if (!row) throw new InvalidJobTransitionError(jobId, 'markAmbiguous');
  return mapRow(row);
}
