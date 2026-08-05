import { InstagramProviderError, InstagramService } from '../../services/instagram';
import { Provider, SecretProvider } from '../../services/secret-provider';
import { TelegramProviderError, TelegramService } from '../../services/telegram';
import { MAX_DELIVERY_ATTEMPTS, retryDelayMs } from '../retry';
import { TransactionRunner, runWorkerTransaction } from '../transaction';

interface OutboundJob {
  id: string;
  workspace_id: string;
  connection_id: string;
  message_id: string;
  provider: Provider;
  recipient_id: string;
  attempts: number;
  content: string;
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
  const transaction = dependencies.transaction ?? runWorkerTransaction;
  const job = await transaction(async db => {
    const result = await db.query(
      `UPDATE outbound_jobs j SET status = 'processing', attempts = attempts + 1
       FROM messages m WHERE j.id = $1 AND j.message_id = m.id
       AND j.status IN ('pending', 'retryable_failed') AND j.next_attempt_at <= NOW()
       RETURNING j.*, m.content`,
      [outboundJobId]
    );
    return result.rows[0] as OutboundJob | undefined;
  });
  if (!job) return { outcome: 'ignored' as const };

  try {
    const secret = await secrets.getConnectionSecret({
      connectionId: job.connection_id, workspaceId: job.workspace_id, provider: job.provider,
    });
    const ack = await (dependencies.sender ?? defaultSender).send(job.provider, secret.accessToken, job.recipient_id, job.content);
    await transaction(async db => {
      await db.query(
        `UPDATE outbound_jobs SET status = 'sent', provider_message_id = $2, last_error = NULL WHERE id = $1`,
        [job.id, ack.providerMessageId]
      );
      await db.query("UPDATE messages SET delivery_status = 'sent' WHERE id = $1", [job.message_id]);
    });
    return { outcome: 'sent' as const };
  } catch (error) {
    const providerError = error instanceof TelegramProviderError || error instanceof InstagramProviderError ? error : undefined;
    const permanent = providerError ? !providerError.retryable : job.attempts >= MAX_DELIVERY_ATTEMPTS;
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
    return { outcome: permanent ? 'permanent_failed' as const : 'retryable_failed' as const, retryInMs: permanent ? undefined : delay };
  }
}

function safeError(error: unknown): string {
  if (error instanceof TelegramProviderError || error instanceof InstagramProviderError) return error.message.slice(0, 500);
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'Provider request timed out';
  return 'Provider delivery failed';
}
