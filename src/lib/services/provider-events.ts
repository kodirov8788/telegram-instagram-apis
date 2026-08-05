import { createHash } from 'node:crypto';
import { runtimeRoleTransaction } from '@/lib/db';

export interface InsertProviderEventResult {
  id: string | null;
  status: string | null;
  isDuplicate: boolean;
}

/**
 * Inserts a provider event atomically into the database.
 * Uses ON CONFLICT DO NOTHING to guarantee idempotency.
 * Resolves active connection using the webhook identifier and provider.
 * Under runtime role context, App GUCs are set to satisfy RLS policies.
 */
export async function insertProviderEvent(params: {
  workspaceId: string;
  connectionId: string;
  provider: 'telegram' | 'instagram';
  providerEventId: string;
  payload: unknown;
  webhookIdentifier: string;
}): Promise<InsertProviderEventResult> {
  // Hash the exact JSON string persisted below. This is deterministic for a given
  // parsed object instance, but it is not a canonical JSON hash across key orderings;
  // database uniqueness remains the authoritative deduplication mechanism.
  const serialized = JSON.stringify(params.payload);
  const payloadHash = createHash('sha256').update(serialized).digest('hex');

  return runtimeRoleTransaction(async client => {
    // Set transaction-local GUCs for webhook resolution RLS policy
    await client.query("SELECT set_config('app.webhook_identifier', $1, true)", [params.webhookIdentifier]);
    await client.query("SELECT set_config('app.webhook_provider', $1, true)", [params.provider]);

    const queryText = `
      INSERT INTO public.provider_events (
        workspace_id,
        connection_id,
        provider,
        provider_event_id,
        payload,
        payload_hash,
        status
      ) VALUES ($1, $2, $3, $4, $5, $6, 'received')
      ON CONFLICT (connection_id, provider_event_id) DO NOTHING
      RETURNING id, status
    `;

    const result = await client.query(queryText, [
      params.workspaceId,
      params.connectionId,
      params.provider,
      params.providerEventId,
      serialized,
      payloadHash,
    ]);

    if (result.rows.length === 0) {
      return { id: null, status: null, isDuplicate: true };
    }

    return {
      id: result.rows[0].id,
      status: result.rows[0].status,
      isDuplicate: false,
    };
  });
}
