import { createHash } from 'node:crypto';
import pool from '../db';
import { PgmqQueueAdapter } from '../queue/pgmq-adapter';

export interface InsertProviderEventInput {
  workspaceId: string;
  connectionId: string;
  provider: 'telegram' | 'instagram';
  providerEventId: string;
  payload: unknown;
}

export interface InsertProviderEventResult {
  id: string | null;
  status: string | null;
  isDuplicate: boolean;
}

const adapter = new PgmqQueueAdapter();

/**
 * Records an inbound webhook delivery in the provider_events ledger and,
 * if it's new, enqueues its id for background processing — all in one
 * transaction, so a webhook can never enqueue an event it failed to
 * durably record (or vice versa).
 *
 * Deduplicates on (connection_id, provider_event_id): a redelivered
 * webhook (Telegram/Meta retry) for the same connection is recognized here
 * and never reaches the queue a second time.
 */
export async function insertProviderEvent(input: InsertProviderEventInput): Promise<InsertProviderEventResult> {
  const payloadJson = JSON.stringify(input.payload);
  const payloadHash = createHash('sha256').update(payloadJson).digest('hex');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const inserted = await client.query(
      `INSERT INTO provider_events (workspace_id, connection_id, provider, provider_event_id, payload, payload_hash, status)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, 'received')
       ON CONFLICT (connection_id, provider_event_id) DO NOTHING
       RETURNING id, status`,
      [input.workspaceId, input.connectionId, input.provider, input.providerEventId, payloadJson, payloadHash]
    );

    const row = inserted.rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      return { id: null, status: null, isDuplicate: true };
    }

    await adapter.send(client, 'inbound_events', { v: 1, providerEventId: row.id });
    await client.query(`UPDATE provider_events SET status = 'queued', updated_at = NOW() WHERE id = $1`, [row.id]);

    await client.query('COMMIT');
    return { id: row.id, status: 'queued', isDuplicate: false };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
