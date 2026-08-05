import { InstagramProviderError, InstagramService } from '../../services/instagram';
import { ConnectionCredentialError, Provider, SecretProvider } from '../../services/secret-provider';
import { TelegramProviderError, TelegramService } from '../../services/telegram';
import { MAX_DELIVERY_ATTEMPTS, retryDelayMs } from '../retry';
import { TransactionRunner, workerRecordTransaction } from '../transaction';
import { RetryableWorkError } from '../errors';

interface OutboundJob {
  id: string;
  workspace_id: string;
  connection_id: string;
  message_id: string;
  provider: Provider;
  recipient_id: string;
  attempts: number;
  content: string;
  dispatched_at: Date | string | null;
  provider_message_id: string | null;
}

export interface ProviderSender {
  send(provider: Provider, token: string, recipientId: string, content: string): Promise<{ providerMessageId: string }>;
}

const defaultSender: ProviderSender = {
  async send(provider, token, recipientId, content) {
    if (provider === 'telegram') {
      const result = await new TelegramService(token).sendMessage(recipientId, content);
      return { providerMessageId: String(result.message_id) };
    }
    const result = await new InstagramService(token).sendDirectMessage(recipientId, content);
    return { providerMessageId: String(result.message_id ?? result.recipient_id) };
  },
};

export async function processOutboundJob(
  outboundJobId: string,
  secrets: SecretProvider,
  dependencies: { transaction?: TransactionRunner; sender?: ProviderSender; random?: () => number } = {}
) {
  const transaction = dependencies.transaction ?? workerRecordTransaction('outbound_jobs', outboundJobId);
  const job = await transaction(async db => {
    const result = await db.query(
      `UPDATE outbound_jobs j SET status = 'processing', attempts = attempts + 1, locked_at = NOW(), updated_at = NOW()
       FROM messages m WHERE j.id = $1 AND j.message_id = m.id
       AND ((j.status IN ('pending', 'queued', 'retryable_failed') AND j.next_attempt_at <= NOW())
         OR (j.status = 'processing' AND j.locked_at < NOW() - INTERVAL '10 minutes'))
       RETURNING j.*, m.content`,
      [outboundJobId]
    );
    return result.rows[0] as OutboundJob | undefined;
  });
  if (!job) {
    const pending = await transaction(db => db.query(
      "SELECT status, GREATEST(0, EXTRACT(EPOCH FROM (next_attempt_at - NOW())) * 1000)::bigint AS delay_ms FROM outbound_jobs WHERE id=$1",
      [outboundJobId]
    ));
    if (['pending', 'queued', 'processing', 'retryable_failed'].includes(pending.rows[0]?.status)) {
      throw new RetryableWorkError(Number(pending.rows[0]?.delay_ms || 5_000), 'Outbound job is not claimable yet');
    }
    return { outcome: 'ignored' as const };
  }

  if (job.dispatched_at && !job.provider_message_id) {
    await markAmbiguous(transaction, job, 'Provider dispatch outcome is unknown after worker recovery');
    return { outcome: 'ambiguous' as const };
  }

  let dispatched = false;
  try {
    const secret = await secrets.getConnectionSecret({
      connectionId: job.connection_id, workspaceId: job.workspace_id, provider: job.provider,
    });
    const dispatch = await transaction(db => db.query(
      `UPDATE outbound_jobs SET dispatched_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND dispatched_at IS NULL
       RETURNING id`,
      [job.id]
    ));
    if (dispatch.rows.length === 0) {
      await markAmbiguous(transaction, job, 'Provider dispatch state changed before delivery');
      return { outcome: 'ambiguous' as const };
    }
    dispatched = true;
    const ack = await (dependencies.sender ?? defaultSender).send(job.provider, secret.accessToken, job.recipient_id, job.content);
    await transaction(async db => {
      await db.query(
        `UPDATE outbound_jobs SET status = 'sent', provider_message_id = $2, last_error = NULL,
          sent_at = NOW(), locked_at = NULL, updated_at = NOW() WHERE id = $1`,
        [job.id, ack.providerMessageId]
      );
      await db.query("UPDATE messages SET delivery_status = 'sent' WHERE id = $1", [job.message_id]);
      await db.query("UPDATE messages SET provider_message_id = $2 WHERE id = $1", [job.message_id, ack.providerMessageId]);
    });
    return { outcome: 'sent' as const };
  } catch (error) {
    if (dispatched) {
      await markAmbiguous(transaction, job, safeError(error));
      return { outcome: 'ambiguous' as const };
    }
    const providerError = error instanceof TelegramProviderError || error instanceof InstagramProviderError ? error : undefined;
    const permanent = error instanceof ConnectionCredentialError || job.attempts >= MAX_DELIVERY_ATTEMPTS || (providerError ? !providerError.retryable : false);
    const delay = retryDelayMs(job.attempts, providerError?.retryAfterMs, dependencies.random);
    await transaction(async db => {
      await db.query(
        `UPDATE outbound_jobs SET status = $2, last_error = $3,
          next_attempt_at = CASE WHEN $2 = 'retryable_failed' THEN NOW() + ($4 * INTERVAL '1 millisecond') ELSE next_attempt_at END
         WHERE id = $1`,
        [job.id, permanent ? 'permanent_failed' : 'retryable_failed', safeError(error), delay]
      );
      if (permanent) await db.query("UPDATE messages SET delivery_status = 'failed' WHERE id = $1", [job.message_id]);
    });
    if (!permanent) throw new RetryableWorkError(delay, 'Outbound delivery is retryable');
    return { outcome: 'permanent_failed' as const };
  }
}

async function markAmbiguous(transaction: TransactionRunner, job: OutboundJob, reason: string): Promise<void> {
  await transaction(async db => {
    await db.query(
      `UPDATE outbound_jobs SET status = 'ambiguous', last_error = $2,
        locked_at = NULL, updated_at = NOW() WHERE id = $1`,
      [job.id, reason.slice(0, 500)]
    );
    await db.query("UPDATE messages SET delivery_status = 'unknown' WHERE id = $1", [job.message_id]);
  });
}

function safeError(error: unknown): string {
  if (error instanceof TelegramProviderError || error instanceof InstagramProviderError) return error.message.slice(0, 500);
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'Provider request timed out';
  return 'Provider delivery failed';
}
