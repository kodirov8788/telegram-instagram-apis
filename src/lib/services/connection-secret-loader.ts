import { query } from '../db';

/**
 * Fail-closed loader for per-connection secrets stored via migration 014's
 * `get_connection_secret` / `set_connection_secret` SQL functions (Supabase
 * Vault-backed, with a transitional plaintext fallback for connections not
 * yet migrated).
 *
 * Never throws a raw DB error up to a caller — a stray raw error could end
 * up interpolated into a log line or HTTP response and leak details about
 * why a secret lookup failed (e.g. distinguishing "wrong tenant" from
 * "no such connection" via error text). Any failure — no row, wrong
 * tenant, no vault entry, malformed JSON — resolves to `null`.
 */
export async function getConnectionSecret(
  connectionId: string,
  workspaceId: string
): Promise<Record<string, unknown> | null> {
  if (!connectionId || !workspaceId) return null;
  try {
    const res = await query(`SELECT public.get_connection_secret($1, $2) AS secret`, [connectionId, workspaceId]);
    const raw = res.rows[0]?.secret;
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as Record<string, unknown>;
  } catch {
    // Deliberately swallow the error — never log or rethrow it, since the
    // secret lookup itself (or its failure reason) must never surface.
    return null;
  }
}

/**
 * Rotation primitive: stores `newCredentials` as a fresh Vault secret and
 * repoints the connection's `credentials_vault_id` to it. Tenant-scoped by
 * (connectionId, workspaceId), same as `getConnectionSecret`.
 */
export async function rotateConnectionSecret(
  connectionId: string,
  workspaceId: string,
  newCredentials: Record<string, unknown>
): Promise<void> {
  if (!connectionId || !workspaceId) {
    throw new Error('connectionId and workspaceId are required');
  }
  await query(`SELECT public.set_connection_secret($1, $2, $3, $4)`, [
    connectionId,
    workspaceId,
    JSON.stringify(newCredentials),
    `channel_connection:${connectionId}:rotated`,
  ]);
}
