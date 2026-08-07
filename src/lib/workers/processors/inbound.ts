import { query } from '../../db';
import { MessageNormalizerService } from '../../services/message-queue';
import { AIIntelligenceService } from '../../services/ai-intelligence';
import { RetryableWorkError } from '../errors';

const MAX_INBOUND_ATTEMPTS = 8;

interface ProviderEventRow {
  id: string;
  workspace_id: string;
  connection_id: string;
  provider: 'telegram' | 'instagram';
  payload: any;
  attempts: number;
}

export type InboundOutcome = 'processed' | 'ignored' | 'permanent_failed';

/**
 * Claims a `provider_events` row and runs it through the existing AI
 * processing pipeline. Called by the worker with only the event's id (the
 * queue payload never carries message content) — this is where the actual
 * classification/reply/dispatch work happens, entirely outside the
 * webhook request.
 *
 * Claim is a single atomic conditional UPDATE: it only succeeds for rows
 * that are claimable (received/queued/retryable_failed, or stuck in
 * 'processing' for over 2 minutes — a crashed worker's stale claim). Two
 * workers racing on the same event will only ever have one win the UPDATE.
 */
export async function processInboundEvent(providerEventId: string): Promise<{ outcome: InboundOutcome }> {
  const claimed = await query(
    `UPDATE provider_events
     SET status = 'processing', attempts = attempts + 1, updated_at = NOW()
     WHERE id = $1
       AND (status IN ('received', 'queued', 'retryable_failed')
         OR (status = 'processing' AND updated_at < NOW() - INTERVAL '2 minutes'))
     RETURNING id, workspace_id, connection_id, provider, payload, attempts`,
    [providerEventId]
  );

  const event: ProviderEventRow | undefined = claimed.rows[0];
  if (!event) return { outcome: 'ignored' };

  const message =
    event.provider === 'telegram'
      ? MessageNormalizerService.normalizeTelegramMessage(event.workspace_id, event.payload, event.connection_id)
      : MessageNormalizerService.normalizeInstagramMessage(event.workspace_id, event.payload, event.connection_id);

  if (!message) {
    await query(
      `UPDATE provider_events SET status = 'permanent_failed', last_error = $2, updated_at = NOW() WHERE id = $1`,
      [event.id, 'Payload did not normalize to a supported message']
    );
    return { outcome: 'permanent_failed' };
  }

  try {
    await AIIntelligenceService.processIncomingMessage({ ...message, providerEventId: event.id });
    await query(
      `UPDATE provider_events SET status = 'processed', processed_at = NOW(), last_error = NULL, updated_at = NOW() WHERE id = $1`,
      [event.id]
    );
    return { outcome: 'processed' };
  } catch (error: any) {
    const isPermanent = event.attempts >= MAX_INBOUND_ATTEMPTS;
    await query(
      `UPDATE provider_events SET status = $2, last_error = $3, updated_at = NOW() WHERE id = $1`,
      [event.id, isPermanent ? 'permanent_failed' : 'retryable_failed', String(error?.message ?? error).slice(0, 500)]
    );
    if (isPermanent) return { outcome: 'permanent_failed' };
    throw new RetryableWorkError(5_000, 'Inbound processing is retryable');
  }
}
