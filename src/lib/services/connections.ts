import { query, type DbClient } from '../db';

/**
 * Non-secret-leaking projection shared by every list/detail response.
 * Deliberately excludes `credentials` and `credentials_vault_id` (the raw
 * vault UUID isn't a secret value, but it's also not useful to a UI and
 * omitting it keeps the "never touch anything credential-shaped" rule
 * mechanical to audit) — callers only ever see whether a vault credential
 * is present via the derived `has_vault_credential` boolean.
 */
const SAFE_COLUMNS = `id, workspace_id, channel, account_identifier, is_active, last_synced_at, created_at,
  (credentials_vault_id IS NOT NULL) AS has_vault_credential`;

export interface CreateConnectionInput {
  workspaceId: string;
  channel: 'telegram' | 'instagram';
  accountIdentifier: string;
}

export interface UpdateConnectionInput {
  accountIdentifier?: string;
  isActive?: boolean;
}

export class ConnectionsService {
  static async listConnections(workspaceId: string, client: DbClient = { query }) {
    const res = await client.query(
      `SELECT ${SAFE_COLUMNS} FROM channel_connections WHERE workspace_id = $1 ORDER BY created_at DESC`,
      [workspaceId]
    );
    return res.rows;
  }

  static async getConnection(workspaceId: string, id: string, client: DbClient = { query }) {
    const res = await client.query(
      `SELECT ${SAFE_COLUMNS} FROM channel_connections WHERE id = $1 AND workspace_id = $2`,
      [id, workspaceId]
    );
    return res.rows[0] ?? null;
  }

  // credentials is NOT NULL on the table with no default, and this route
  // deliberately never accepts a raw token — new connections are created
  // with an intentionally-empty placeholder object, and a caller must go
  // through PATCH's `credential` field (which routes through
  // set_connection_secret / rotateConnectionSecret) before the connection
  // is actually usable. is_active starts false for the same reason: a
  // connection with no credential yet should not look "live" in listings.
  static async createConnection(input: CreateConnectionInput, client: DbClient = { query }) {
    const res = await client.query(
      `INSERT INTO channel_connections (workspace_id, channel, account_identifier, credentials, is_active)
       VALUES ($1, $2, $3, '{}'::jsonb, FALSE)
       RETURNING ${SAFE_COLUMNS}`,
      [input.workspaceId, input.channel, input.accountIdentifier]
    );
    return res.rows[0];
  }

  static async updateConnection(workspaceId: string, id: string, updates: UpdateConnectionInput, client: DbClient = { query }) {
    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (col: string, value: unknown) => { params.push(value); sets.push(`${col} = $${params.length}`); };

    if (updates.accountIdentifier !== undefined) push('account_identifier', updates.accountIdentifier);
    if (updates.isActive !== undefined) push('is_active', updates.isActive);
    if (sets.length === 0) return ConnectionsService.getConnection(workspaceId, id, client);

    params.push(id, workspaceId);
    const res = await client.query(
      `UPDATE channel_connections SET ${sets.join(', ')}
       WHERE id = $${params.length - 1} AND workspace_id = $${params.length}
       RETURNING ${SAFE_COLUMNS}`,
      params
    );
    return res.rows[0] ?? null;
  }

  // Hard delete, deliberately: unlike knowledge_items, this row *does* have
  // downstream references (customers.connection_id, conversations, a
  // credentials_vault_id pointing at a Vault secret) but all are handled
  // safely — customers/conversations only soft-reference connection_id
  // (no FK cascade is defined that would nuke conversation history), and
  // the orphaned Vault secret is inert ciphertext with no further access
  // path once credentials_vault_id's owning row is gone (get_connection_secret
  // requires the row to exist and match workspace_id). A soft "deactivated"
  // state already exists via is_active, so DELETE is for actually removing
  // the connection record itself, mirroring knowledge-item delete's
  // reasoning: is_active already covers "stop using this", DELETE covers
  // "get rid of it entirely".
  static async deleteConnection(workspaceId: string, id: string, client: DbClient = { query }) {
    const res = await client.query(
      `DELETE FROM channel_connections WHERE id = $1 AND workspace_id = $2 RETURNING id`,
      [id, workspaceId]
    );
    return res.rows[0] ?? null;
  }
}
