-- Issue #57: connection-scoped customer identity and least-privilege mutation.
-- Forward recovery: inspect duplicate groups and invalid connection references with privileged,
-- access-controlled queries. Restore an orphaned connection or reconcile its workspace from an
-- authoritative provider mapping; correct provider/connection inputs when they disagree. Never
-- auto-delete, merge, clear, or reassign customer identities from these aggregate counts alone.
-- After reviewed corrections reduce both counts to zero, rerun this idempotent migration.
-- Rollback: restore direct customer DML only if the application is rolled back first; dropping
-- the function/index/FK is safe, but does not undo identities already created through the API.
BEGIN;

LOCK TABLE public.customers IN SHARE ROW EXCLUSIVE MODE;

DO $do$
DECLARE duplicate_identities bigint; tenant_mismatches bigint;
BEGIN
  SELECT COUNT(*) INTO duplicate_identities FROM (
    SELECT 1 FROM public.customers
    WHERE connection_id IS NOT NULL AND provider_user_id IS NOT NULL
    GROUP BY workspace_id, connection_id, provider_user_id HAVING COUNT(*) > 1
  ) duplicates;
  SELECT COUNT(*) INTO tenant_mismatches
  FROM public.customers c
  LEFT JOIN public.channel_connections cc ON cc.id = c.connection_id
  WHERE c.connection_id IS NOT NULL
    AND (cc.id IS NULL OR c.workspace_id <> cc.workspace_id);
  IF duplicate_identities > 0 OR tenant_mismatches > 0 THEN
    RAISE EXCEPTION 'migration 007 preflight failed: duplicate identity groups=%, tenant mismatches=%',
      duplicate_identities, tenant_mismatches;
  END IF;
END $do$;

DO $do$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'channel_connections_id_workspace_unique'
      AND conrelid = 'public.channel_connections'::regclass
  ) THEN
    ALTER TABLE public.channel_connections
      ADD CONSTRAINT channel_connections_id_workspace_unique UNIQUE (id, workspace_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'customers_connection_tenant_fk'
      AND conrelid = 'public.customers'::regclass
  ) THEN
    ALTER TABLE public.customers
      ADD CONSTRAINT customers_connection_tenant_fk
      FOREIGN KEY (connection_id, workspace_id)
      REFERENCES public.channel_connections (id, workspace_id) NOT VALID;
  END IF;
END $do$;

ALTER TABLE public.customers VALIDATE CONSTRAINT customers_connection_tenant_fk;

CREATE UNIQUE INDEX IF NOT EXISTS customers_connection_provider_identity_unique
  ON public.customers (workspace_id, connection_id, provider_user_id)
  WHERE connection_id IS NOT NULL AND provider_user_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.upsert_connection_customer(
  p_connection_id UUID,
  p_provider public.channel_type,
  p_provider_user_id TEXT,
  p_full_name TEXT DEFAULT NULL,
  p_username TEXT DEFAULT NULL
) RETURNS public.customers
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  actor UUID;
  derived_workspace UUID;
  customer public.customers%ROWTYPE;
BEGIN
  actor := NULLIF(current_setting('app.user_id', true), '')::UUID;
  IF actor IS NULL THEN
    RAISE EXCEPTION 'authenticated identity required' USING ERRCODE = '28000';
  END IF;
  IF p_connection_id IS NULL OR p_provider IS NULL OR NULLIF(BTRIM(p_provider_user_id), '') IS NULL THEN
    RAISE EXCEPTION 'connection, provider, and provider user identity are required' USING ERRCODE = '22023';
  END IF;

  SELECT cc.workspace_id INTO derived_workspace
  FROM public.channel_connections cc
  WHERE cc.id = p_connection_id AND cc.channel = p_provider AND cc.is_active IS TRUE;
  IF derived_workspace IS NULL THEN
    RAISE EXCEPTION 'active provider connection not found' USING ERRCODE = '23503';
  END IF;
  IF NOT public.current_user_is_workspace_member(derived_workspace) THEN
    RAISE EXCEPTION 'workspace access denied' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.customers (
    workspace_id, connection_id, provider_user_id, full_name,
    telegram_id, telegram_username, instagram_id, instagram_username, last_contact_at
  ) VALUES (
    derived_workspace, p_connection_id, BTRIM(p_provider_user_id), p_full_name,
    CASE WHEN p_provider = 'telegram' THEN BTRIM(p_provider_user_id) END,
    CASE WHEN p_provider = 'telegram' THEN p_username END,
    CASE WHEN p_provider = 'instagram' THEN BTRIM(p_provider_user_id) END,
    CASE WHEN p_provider = 'instagram' THEN p_username END,
    NOW()
  )
  ON CONFLICT (workspace_id, connection_id, provider_user_id)
    WHERE connection_id IS NOT NULL AND provider_user_id IS NOT NULL
  DO UPDATE SET
    full_name = COALESCE(EXCLUDED.full_name, customers.full_name),
    telegram_username = COALESCE(EXCLUDED.telegram_username, customers.telegram_username),
    instagram_username = COALESCE(EXCLUDED.instagram_username, customers.instagram_username),
    last_contact_at = NOW()
  RETURNING * INTO customer;

  RETURN customer;
END $fn$;

REVOKE ALL ON FUNCTION public.upsert_connection_customer(UUID, public.channel_type, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_connection_customer(UUID, public.channel_type, TEXT, TEXT, TEXT) TO ydeck_tenant_runtime_v2;
REVOKE INSERT, UPDATE, DELETE ON public.customers FROM ydeck_tenant_runtime_v2;
GRANT SELECT ON public.customers TO ydeck_tenant_runtime_v2;

COMMIT;
