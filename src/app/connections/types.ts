/**
 * Mirrors ConnectionsService's SAFE_COLUMNS projection exactly. There is no
 * `credentials` / `credentials_vault_id` field here on purpose — the API
 * never sends one, and this type must not invent one that later gets
 * populated by mistake and rendered.
 */
export interface Connection {
  id: string;
  workspace_id: string;
  channel: "telegram" | "instagram";
  account_identifier: string;
  is_active: boolean;
  last_synced_at: string | null;
  created_at: string;
  has_vault_credential: boolean;
}

export interface TestResult {
  ok: boolean;
  detail?: string;
}
