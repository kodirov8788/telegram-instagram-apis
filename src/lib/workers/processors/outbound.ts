import { query } from '../../db';
import {
  claimNextJob,
  markSent,
  markRetryableFailed,
  markPermanentFailed,
  markAmbiguous,
  markDispatched,
  OutboundJob,
} from '../../services/outbound-jobs';
import { getConnectionSecret } from '../../services/connection-secret-loader';
import { TelegramService } from '../../services/telegram';
import { InstagramService } from '../../services/instagram';
import { ProviderDeliveryError } from '../../services/provider-delivery-error';
import { retryDelayMs, MAX_DELIVERY_ATTEMPTS_OUTBOUND } from '../retry';
import { RetryableWorkError } from '../errors';

export type OutboundOutcome = 'sent' | 'retryable_failed' | 'permanent_failed' | 'ambiguous' | 'skipped';

async function updateMessageDeliveryStatus(messageId: string, status: 'sent' | 'failed'): Promise<void> {
  // Job-terminal-state -> message.delivery_status propagation. Only called
  // for terminal job outcomes (sent/permanent_failed/ambiguous), never for
  // retryable_failed, so messages.delivery_status never flips to 'failed'
  // while the job is still going to retry — it would contradict a job that
  // may still succeed.
  await query(`UPDATE messages SET delivery_status = $2 WHERE id = $1`, [messageId, status]);
}

/**
 * Claims the next due outbound job and drives it to a terminal or
 * retryable outcome. Called by the worker with only the job's id (queue
 * payload is ID-only) — mirrors `processInboundEvent`'s shape.
 *
 * Ambiguous-delivery protection (issue #46, migration 015):
 *   - A job reclaimed with `dispatched_at` already set and no
 *     `provider_message_id` is an unconfirmed prior attempt — this
 *     function NEVER calls the provider for that case, it goes straight to
 *     `ambiguous`.
 *   - Otherwise, immediately before the provider call, `markDispatched`
 *     atomically sets `dispatched_at` (WHERE dispatched_at IS NULL). If
 *     that update affects 0 rows, a concurrent/duplicate attempt already
 *     dispatched this job — skip the provider call and mark ambiguous
 *     rather than risk a double send.
 */
/**
 * NOTE on queue-vs-DB claim semantics: like inbound's `processInboundEvent`,
 * this claims "the next globally due job" via `claimNextJob()` rather than
 * looking up `outboundJobId` specifically — the queue message is a wake-up
 * signal, not a strict work-item pointer. A `retryable_failed` outcome
 * therefore throws `RetryableWorkError` so `runtime.ts` re-enqueues *this*
 * queue message with a delay (mirroring inbound) — without that, a
 * retryable job would sit in the DB with a future `next_attempt_at` but no
 * queue message left to ever wake a worker back up for it.
 */
export async function processOutboundJob(outboundJobId: string): Promise<{ outcome: OutboundOutcome }> {
  const job = await claimNextJob();
  // Nothing claimable right now (e.g. another worker already took it, or
  // this queue message outlived its job's window) — safe to just delete
  // this queue message; any still-pending job will be picked up by a
  // future poll's queue message (or its own next_attempt_at once
  // something re-triggers a read).
  if (!job) return { outcome: 'skipped' };

  let outcome: OutboundOutcome;
  let retryDelayMsForThrow: number | undefined;
  try {
    const result = await runClaimedJob(job);
    outcome = result.outcome;
    retryDelayMsForThrow = result.delayMs;
  } catch (error) {
    // Any unexpected error escaping runClaimedJob (e.g. a transition race)
    // is retryable at the queue level rather than silently swallowed.
    throw new RetryableWorkError(5_000, `Unexpected outbound processing error: ${String((error as Error)?.message ?? error)}`);
  }

  if (outcome === 'retryable_failed') {
    throw new RetryableWorkError(retryDelayMsForThrow ?? 5_000, 'Outbound delivery is retryable');
  }
  return { outcome };
}

async function runClaimedJob(job: OutboundJob): Promise<{ outcome: OutboundOutcome; delayMs?: number }> {
  // Unconfirmed prior attempt: never call the provider again.
  if (job.dispatchedAt !== null && !job.providerMessageId) {
    await markAmbiguous(job.id, 'Reclaimed job had an unconfirmed prior dispatch attempt');
    await updateMessageDeliveryStatus(job.messageId, 'failed');
    return { outcome: 'ambiguous' };
  }

  const connRes = await query(
    `SELECT id, is_active FROM channel_connections WHERE id = $1 AND workspace_id = $2 AND channel = $3`,
    [job.connectionId, job.workspaceId, job.channel]
  );
  const connection = connRes.rows[0];
  if (!connection || connection.is_active !== true) {
    await markPermanentFailed(job.id, "Connection is missing, inactive, or does not match this job's tenant");
    await updateMessageDeliveryStatus(job.messageId, 'failed');
    return { outcome: 'permanent_failed' };
  }

  const secret = await getConnectionSecret(job.connectionId, job.workspaceId);
  if (!secret) {
    // Missing credential won't fix itself on retry.
    await markPermanentFailed(job.id, 'No credential available for this connection');
    await updateMessageDeliveryStatus(job.messageId, 'failed');
    return { outcome: 'permanent_failed' };
  }

  const dispatched = await markDispatched(job.id);
  if (!dispatched) {
    // Someone else already dispatched this attempt (or a concurrent
    // reclaim beat us to it) — never call the provider.
    await markAmbiguous(job.id, 'Dispatch marker was already set by a concurrent attempt');
    await updateMessageDeliveryStatus(job.messageId, 'failed');
    return { outcome: 'ambiguous' };
  }

  try {
    const providerMessageId = await callProvider(job, secret);
    await markSent(job.id, providerMessageId);
    await updateMessageDeliveryStatus(job.messageId, 'sent');
    return { outcome: 'sent' };
  } catch (error) {
    if (error instanceof ProviderDeliveryError) {
      if (error.ambiguous) {
        await markAmbiguous(job.id, error.message);
        await updateMessageDeliveryStatus(job.messageId, 'failed');
        return { outcome: 'ambiguous' };
      }
      if (error.retryable && job.attempts < MAX_DELIVERY_ATTEMPTS_OUTBOUND) {
        const delayMs = retryDelayMs(job.attempts, error.retryAfterMs);
        await markRetryableFailed(job.id, error.message, delayMs);
        return { outcome: 'retryable_failed', delayMs };
      }
      // Permanent, or exhausted the outbound attempt budget.
      await markPermanentFailed(job.id, error.message);
      await updateMessageDeliveryStatus(job.messageId, 'failed');
      return { outcome: 'permanent_failed' };
    }
    // Non-provider error (e.g. a DB write failure after a successful
    // send) — treat conservatively as ambiguous rather than guessing.
    await markAmbiguous(job.id, String((error as Error)?.message ?? error));
    await updateMessageDeliveryStatus(job.messageId, 'failed');
    return { outcome: 'ambiguous' };
  }
}

async function callProvider(job: OutboundJob, secret: Record<string, unknown>): Promise<string> {
  if (job.channel === 'telegram') {
    const token = secret.botToken;
    if (typeof token !== 'string' || !token) {
      throw new ProviderDeliveryError('Telegram credential missing botToken', { retryable: false });
    }
    const result = await new TelegramService(token).sendMessage(job.recipientId, job.content);
    return result.providerMessageId;
  }
  if (job.channel === 'instagram') {
    const token = secret.pageAccessToken;
    if (typeof token !== 'string' || !token) {
      throw new ProviderDeliveryError('Instagram credential missing pageAccessToken', { retryable: false });
    }
    const result = await new InstagramService(token).sendDirectMessage(job.recipientId, job.content);
    return result.providerMessageId;
  }
  throw new ProviderDeliveryError(`Unsupported channel: ${job.channel}`, { retryable: false });
}
