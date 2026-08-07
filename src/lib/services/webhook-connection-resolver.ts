import { query } from '../db';

export interface ResolvedChannelConnection {
  connectionId: string;
  workspaceId: string;
}

/**
 * Resolves an inbound channel webhook to its owning workspace by looking up
 * the active `channel_connections` row for the given channel + provider
 * account identifier (e.g. the Instagram Business Account / Page id from
 * `entry.id`, or a Telegram bot username).
 *
 * Returns null (never throws, never falls back to a default workspace) when
 * no active connection matches — callers must treat that as "ignore this
 * event", not as an error, since unknown senders are expected traffic
 * (e.g. a page not yet connected to any workspace).
 *
 * Channel-agnostic by design so it can be reused by other channel webhooks;
 * only the Instagram and Telegram routes consume it today.
 *
 * Deliberately does NOT return `credentials` (plaintext or otherwise) —
 * this resolver is only for tenant/connection identification. Callers that
 * need the connection's actual secret (e.g. the Telegram webhook's
 * secret-token check) must go through
 * `connection-secret-loader#getConnectionSecret`, which is Vault-aware and
 * fails closed.
 */
export async function resolveChannelConnection(
  channel: 'telegram' | 'instagram',
  accountIdentifier: string
): Promise<ResolvedChannelConnection | null> {
  if (!accountIdentifier) return null;

  const res = await query(
    `SELECT id, workspace_id
     FROM channel_connections
     WHERE channel = $1 AND account_identifier = $2 AND is_active = TRUE
     LIMIT 1`,
    [channel, accountIdentifier]
  );

  const row = res.rows[0];
  if (!row) return null;

  return {
    connectionId: row.id,
    workspaceId: row.workspace_id,
  };
}
