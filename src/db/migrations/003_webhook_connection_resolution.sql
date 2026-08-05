-- Task 3: opaque webhook routing locator + narrowly scoped RLS resolution policy.
-- Additive only. Adds a high-entropy, database-unique routing capability to
-- channel_connections and a permissive SELECT policy that lets the existing
-- runtime role resolve exactly one active connection for an unauthenticated
-- webhook request via transaction-local GUCs. Forced RLS on channel_connections
-- is unchanged; no BYPASSRLS role or broad SECURITY DEFINER access is introduced.
BEGIN;

ALTER TABLE public.channel_connections
  ADD COLUMN IF NOT EXISTS webhook_identifier UUID;

ALTER TABLE public.channel_connections
  ALTER COLUMN webhook_identifier SET DEFAULT uuid_generate_v4();

UPDATE public.channel_connections
SET webhook_identifier = uuid_generate_v4()
WHERE webhook_identifier IS NULL;

ALTER TABLE public.channel_connections
  ALTER COLUMN webhook_identifier SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS channel_connections_webhook_identifier_unique
  ON public.channel_connections(webhook_identifier);

DO $do$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'channel_connections'
      AND policyname = 'channel_webhook_resolution_policy'
  ) THEN
    CREATE POLICY channel_webhook_resolution_policy
      ON public.channel_connections
      FOR SELECT
      TO ydeck_tenant_runtime_v2
      USING (
        is_active IS TRUE
        AND webhook_identifier = NULLIF(current_setting('app.webhook_identifier', true), '')::UUID
        AND channel::TEXT = NULLIF(current_setting('app.webhook_provider', true), '')
      );
  END IF;
END $do$;

COMMIT;
