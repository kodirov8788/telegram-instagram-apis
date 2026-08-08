import pool, { query, DbClient } from '../db';
import { PgmqQueueAdapter } from '../queue/pgmq-adapter';

const adapter = new PgmqQueueAdapter();

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
  dispatchedAt: Date | null;
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
    dispatchedAt: row.dispatched_at ?? null,
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
export async function createJob(input: CreateOutboundJobInput, client?: DbClient): Promise<OutboundJob> {
  const runner = client ?? { query: (text: string, params?: any[]) => query(text, params) };
  try {
    const result = await runner.query(
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
 * Creates the job row and publishes `{v:1, outboundJobId}` to the
 * `outbound_jobs` pgmq queue in a single DB transaction — mirroring
 * `provider-events.ts`'s `insertProviderEvent`, which does the identical
 * "ledger insert + ydeck_queue.send in one transaction" pattern for
 * inbound. pgmq's `send` is itself a table insert under the hood (migration
 * 010), so it can safely participate in the same local-DB transaction as
 * the job insert — no network call is made here, so no long-held
 * transaction risk. Duplicate-active-job protection (the partial unique
 * index) still applies: a second attempt for the same message rolls the
 * whole transaction back and raises `DuplicateActiveJobError`, so no
 * partial "job created but not enqueued" state is possible.
 */
export async function createJobAndEnqueue(input: CreateOutboundJobInput): Promise<OutboundJob> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const job = await createJob(input, client);
    await enqueueOutboundJob(client, job.id);
    await client.query('COMMIT');
    return job;
  } catch (error) {
    // Covers both createJob's DuplicateActiveJobError (the INSERT's unique
    // violation) and any enqueue failure — either way nothing should be
    // left committed.
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Publishes `{v:1, outboundJobId}` to the `outbound_jobs` pgmq queue using
 * the given client — exists so callers that need the message-insert +
 * job-creation + enqueue to be one atomic unit (closing the "message
 * persisted, no job/enqueue yet" crash window — see ai-intelligence.ts's
 * auto-mode block and the approve route) can call `createJob(input,
 * client)` + `enqueueOutboundJob(client, job.id)` directly inside their own
 * transaction, instead of going through `createJobAndEnqueue`'s
 * self-contained transaction (which necessarily can't also cover a
 * caller-owned message write).
 */
export async function enqueueOutboundJob(client: DbClient, jobId: string): Promise<void> {
  await adapter.send(client, 'outbound_jobs', { v: 1, outboundJobId: jobId });
}

/**
 * Ambiguous-delivery protection (issue #46): atomically marks a claimed
 * job as "about to call the provider" immediately before the network call
 * is made. Returns false if the job was already dispatched (someone else's
 * attempt got here first, or a reclaim already routed this attempt away
 * from ever calling the provider) — callers must skip the provider call
 * when this returns false.
 */
export async function markDispatched(jobId: string): Promise<boolean> {
  const result = await query(
    `UPDATE outbound_jobs SET dispatched_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND status = 'processing' AND dispatched_at IS NULL
     RETURNING id`,
    [jobId]
  );
  return Boolean(result.rows[0]);
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

/**
 * Resolves an `ambiguous` job after an explicit decision by whoever
 * investigated it (an operator, or an automated reconciliation check
 * against the provider's own delivery records — not built here, this is
 * just the resolution primitive so `ambiguous` is not a true dead end).
 *
 * - 'confirmed_delivered': the provider did receive it — mark the job
 *   `sent` without re-dispatching, optionally recording the provider's
 *   message id if the investigation recovered one.
 * - 'confirmed_not_delivered': the provider never received it — safe to
 *   retry normally, so this schedules a retry via `next_attempt_at` rather
 *   than dispatching immediately (respects the same backoff discipline as
 *   any other retry, doesn't bypass `dispatched_at`'s "already attempted"
 *   guard by clearing it, which allows the worker to dispatch again).
 * - 'abandon': give up — terminal, matches `permanent_failed`.
 *
 * Rejects the transition from any state other than `ambiguous` — this is
 * not a way to short-circuit the normal `processing` lifecycle.
 */
export type AmbiguousResolution = 'confirmed_delivered' | 'confirmed_not_delivered' | 'abandon';

export async function resolveAmbiguousJob(
  jobId: string,
  resolution: AmbiguousResolution,
  providerMessageId?: string
): Promise<OutboundJob> {
  const result = await (async () => {
    switch (resolution) {
      case 'confirmed_delivered':
        return query(
          `UPDATE outbound_jobs
           SET status = 'sent', provider_message_id = COALESCE($2, provider_message_id), sent_at = NOW(), updated_at = NOW()
           WHERE id = $1 AND status = 'ambiguous'
           RETURNING *`,
          [jobId, providerMessageId ?? null]
        );
      case 'confirmed_not_delivered':
        return query(
          `UPDATE outbound_jobs
           SET status = 'retryable_failed', dispatched_at = NULL, next_attempt_at = NOW(), updated_at = NOW()
           WHERE id = $1 AND status = 'ambiguous'
           RETURNING *`,
          [jobId]
        );
      case 'abandon':
        return query(
          `UPDATE outbound_jobs
           SET status = 'permanent_failed', updated_at = NOW()
           WHERE id = $1 AND status = 'ambiguous'
           RETURNING *`,
          [jobId]
        );
    }
  })();
  const row = result.rows[0];
  if (!row) throw new InvalidJobTransitionError(jobId, `resolveAmbiguousJob:${resolution}`);
  return mapRow(row);
}
