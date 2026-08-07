-- Migration 014: per-connection encrypted credentials via Supabase Vault.
--
-- Issue #47. Adds `channel_connections.credentials_vault_id UUID` as the
-- new/preferred path for storing per-connection provider secrets (Telegram
-- bot tokens, Instagram page access tokens, webhook secrets, etc.), backed
-- by Supabase Vault (pgsodium-encrypted, decrypted only via
-- `vault.decrypted_secrets`).
--
-- STAGED MIGRATION, NOT AUTOMATIC: this migration does NOT touch existing
-- plaintext `credentials` JSONB values. The legacy `credentials` column is
-- left in place, still NOT NULL, still fully functional. Existing
-- connections keep working exactly as before via a documented transitional
-- fallback in `get_connection_secret`. Automatically re-encrypting existing
-- rows inside a migration would mean guessing at operational intent (e.g.
-- whether a given plaintext blob is even still valid, whether downtime is
-- acceptable) — instead, an operator explicitly calls
-- `migrate_connection_credentials_to_vault(connection_id)` per connection,
-- after review, whenever they choose to. This repo has no "create
-- connection" API yet either, so `credentials_vault_id` mainly matters for
-- whoever builds one next — new connections should be created with it set
-- directly (via `set_connection_secret`) rather than via plaintext
-- `credentials`.
--
-- Access model: `vault.decrypted_secrets` is NEVER granted to `anon`,
-- `authenticated`, or any RLS/PostgREST-reachable role. The only way to
-- read a decrypted secret is through the narrow SECURITY DEFINER function
-- `get_connection_secret`, granted only to `ydeck_tenant_runtime_v2` (the
-- app's own privileged runtime role, not exposed to end users), and it
-- verifies (connection_id, workspace_id) together before returning
-- anything — never connection_id alone.
BEGIN;

DO $do$
DECLARE vault_available_version text;
BEGIN
    -- pg_available_extensions lists what CAN be installed (default_version),
    -- not what IS installed (that's pg_extension.extversion, checked below
    -- after CREATE EXTENSION).
    SELECT default_version INTO vault_available_version FROM pg_available_extensions WHERE name = 'supabase_vault';
    IF vault_available_version IS NULL THEN
        RAISE EXCEPTION 'supabase_vault extension is not available on this Postgres instance';
    END IF;
END $do$;

CREATE EXTENSION IF NOT EXISTS supabase_vault;

DO $do$
DECLARE vault_installed_version text;
BEGIN
    SELECT extversion INTO vault_installed_version FROM pg_extension WHERE extname = 'supabase_vault';
    IF vault_installed_version IS NULL THEN
        RAISE EXCEPTION 'supabase_vault extension failed to install';
    END IF;
END $do$;

ALTER TABLE public.channel_connections ADD COLUMN IF NOT EXISTS credentials_vault_id UUID;

-- Never expose decrypted-secret access to RLS/PostgREST-reachable roles.
REVOKE ALL ON ALL TABLES IN SCHEMA vault FROM anon, authenticated;
REVOKE ALL ON SCHEMA vault FROM anon, authenticated;

-- get_connection_secret: the only sanctioned way to read a connection's
-- decrypted secret. Fails closed on every branch: no match on
-- (connection_id, workspace_id) together, inactive connection, or a
-- connection with neither a vault id nor legacy plaintext -> raises.
-- Never falls through to any other implicit default.
CREATE OR REPLACE FUNCTION public.get_connection_secret(
  p_connection_id UUID,
  p_workspace_id UUID
) RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, vault
AS $fn$
DECLARE
  conn RECORD;
  secret TEXT;
BEGIN
  IF p_connection_id IS NULL OR p_workspace_id IS NULL THEN
    RAISE EXCEPTION 'connection and workspace are required' USING ERRCODE = '22023';
  END IF;

  -- Tenant check requires BOTH ids to match the same row — connection_id
  -- alone is never sufficient, preventing workspace A from resolving
  -- workspace B's secret by supplying its own workspace_id.
  SELECT cc.id, cc.workspace_id, cc.credentials_vault_id, cc.credentials
  INTO conn
  FROM public.channel_connections cc
  WHERE cc.id = p_connection_id
    AND cc.workspace_id = p_workspace_id
    AND cc.is_active IS TRUE;

  IF conn.id IS NULL THEN
    RAISE EXCEPTION 'connection not found for workspace' USING ERRCODE = '23503';
  END IF;

  IF conn.credentials_vault_id IS NOT NULL THEN
    SELECT decrypted_secret INTO secret
    FROM vault.decrypted_secrets
    WHERE id = conn.credentials_vault_id;

    IF secret IS NULL THEN
      RAISE EXCEPTION 'vault secret missing for connection' USING ERRCODE = 'P0002';
    END IF;

    RETURN secret;
  END IF;

  -- Transitional fallback: unmigrated connections still have their secret
  -- in plaintext `credentials`. This path exists only for backward
  -- compatibility until an operator explicitly migrates the connection;
  -- it is not a new implicit default and does not apply cross-tenant
  -- (the WHERE clause above already scoped this row to p_workspace_id).
  IF conn.credentials IS NOT NULL THEN
    RETURN conn.credentials::text;
  END IF;

  RAISE EXCEPTION 'connection has no credentials' USING ERRCODE = 'P0002';
END $fn$;

-- set_connection_secret: creates a NEW vault secret and repoints
-- credentials_vault_id on the tenant-verified row. Used both for initial
-- migration and for rotation (calling it again on an already vault-backed
-- connection creates a fresh secret and repoints to it — no downtime, the
-- old secret is simply no longer referenced by this connection).
CREATE OR REPLACE FUNCTION public.set_connection_secret(
  p_connection_id UUID,
  p_workspace_id UUID,
  p_secret TEXT,
  p_name TEXT DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, vault
AS $fn$
DECLARE
  conn RECORD;
  new_vault_id UUID;
BEGIN
  IF p_connection_id IS NULL OR p_workspace_id IS NULL OR NULLIF(p_secret, '') IS NULL THEN
    RAISE EXCEPTION 'connection, workspace, and secret are required' USING ERRCODE = '22023';
  END IF;

  SELECT cc.id INTO conn
  FROM public.channel_connections cc
  WHERE cc.id = p_connection_id AND cc.workspace_id = p_workspace_id;

  IF conn.id IS NULL THEN
    RAISE EXCEPTION 'connection not found for workspace' USING ERRCODE = '23503';
  END IF;

  new_vault_id := vault.create_secret(
    p_secret,
    COALESCE(p_name, 'channel_connection:' || p_connection_id::text || ':' || extract(epoch from clock_timestamp())::text)
  );

  UPDATE public.channel_connections
  SET credentials_vault_id = new_vault_id
  WHERE id = p_connection_id AND workspace_id = p_workspace_id;

  RETURN new_vault_id;
END $fn$;

-- migrate_connection_credentials_to_vault: explicit, operator-invoked ONLY.
-- Never called automatically by this migration or by application code.
-- Reads the connection's current legacy plaintext `credentials` and moves
-- it into Vault via set_connection_secret. No workspace_id parameter is
-- needed here because it derives it from the row itself (an operator
-- already knows which connection_id they intend to migrate); it still
-- routes through set_connection_secret's tenant-scoped update.
CREATE OR REPLACE FUNCTION public.migrate_connection_credentials_to_vault(
  p_connection_id UUID
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, vault
AS $fn$
DECLARE
  conn RECORD;
BEGIN
  SELECT cc.id, cc.workspace_id, cc.credentials
  INTO conn
  FROM public.channel_connections cc
  WHERE cc.id = p_connection_id;

  IF conn.id IS NULL THEN
    RAISE EXCEPTION 'connection not found' USING ERRCODE = '23503';
  END IF;
  IF conn.credentials IS NULL THEN
    RAISE EXCEPTION 'connection has no legacy credentials to migrate' USING ERRCODE = 'P0002';
  END IF;

  RETURN public.set_connection_secret(
    conn.id,
    conn.workspace_id,
    conn.credentials::text,
    'channel_connection:' || conn.id::text || ':migrated'
  );
END $fn$;

REVOKE ALL ON FUNCTION public.get_connection_secret(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_connection_secret(UUID, UUID) TO ydeck_tenant_runtime_v2;

REVOKE ALL ON FUNCTION public.set_connection_secret(UUID, UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_connection_secret(UUID, UUID, TEXT, TEXT) TO ydeck_tenant_runtime_v2;

REVOKE ALL ON FUNCTION public.migrate_connection_credentials_to_vault(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.migrate_connection_credentials_to_vault(UUID) TO ydeck_tenant_runtime_v2;

COMMIT;
