-- Task 5: additive migration for provider_events ledger and idempotency
BEGIN;

-- 1. Add UNIQUE(id, workspace_id) to channel_connections if not exists
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'channel_connections_id_workspace_unique'
      AND conrelid = 'public.channel_connections'::regclass
  ) THEN
    ALTER TABLE public.channel_connections ADD CONSTRAINT channel_connections_id_workspace_unique UNIQUE(id, workspace_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'channel_connections_id_workspace_provider_unique'
      AND conrelid = 'public.channel_connections'::regclass
  ) THEN
    ALTER TABLE public.channel_connections ADD CONSTRAINT channel_connections_id_workspace_provider_unique UNIQUE(id, workspace_id, channel);
  END IF;
END $$;

-- 2. Create provider_events table
CREATE TABLE IF NOT EXISTS public.provider_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
    connection_id UUID NOT NULL,
    provider public.channel_type NOT NULL,
    provider_event_id VARCHAR(255) NOT NULL,
    payload JSONB NOT NULL,
    payload_hash CHAR(64) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'received',
    attempts INTEGER NOT NULL DEFAULT 0,
    processed_at TIMESTAMP WITH TIME ZONE,
    last_error TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT provider_events_status_check CHECK (status IN ('received', 'queued', 'processing', 'processed', 'retryable_failed', 'permanent_failed')),
    CONSTRAINT provider_events_connection_tenant_fk FOREIGN KEY (connection_id, workspace_id, provider) REFERENCES public.channel_connections(id, workspace_id, channel) ON DELETE CASCADE,
    CONSTRAINT provider_events_connection_event_unique UNIQUE (connection_id, provider_event_id)
);

-- 3. Create recovery and query indexes
CREATE INDEX IF NOT EXISTS idx_provider_events_status ON public.provider_events(status);
CREATE INDEX IF NOT EXISTS idx_provider_events_workspace_id ON public.provider_events(workspace_id);

-- 4. Enable and force RLS
ALTER TABLE public.provider_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_events FORCE ROW LEVEL SECURITY;

-- 5. Member policy (similar to other tables, using current_user_is_workspace_member)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'provider_events'
      AND policyname = 'provider_event_tenant_policy'
  ) THEN
    CREATE POLICY provider_event_tenant_policy ON public.provider_events
      USING (current_user_is_workspace_member(workspace_id))
      WITH CHECK (current_user_is_workspace_member(workspace_id));
  END IF;
END $$;

-- 6. Narrow runtime INSERT/SELECT policy tied to active resolved connection/GUCs
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'provider_events'
      AND policyname = 'provider_event_webhook_policy'
  ) THEN
    CREATE POLICY provider_event_webhook_policy ON public.provider_events
      TO ydeck_tenant_runtime_v2
      USING (
        provider::TEXT = NULLIF(current_setting('app.webhook_provider', true), '')
        AND
        connection_id IN (
          SELECT id FROM public.channel_connections
          WHERE is_active IS TRUE
            AND webhook_identifier = NULLIF(current_setting('app.webhook_identifier', true), '')::UUID
            AND channel::TEXT = NULLIF(current_setting('app.webhook_provider', true), '')
        )
      )
      WITH CHECK (
        provider::TEXT = NULLIF(current_setting('app.webhook_provider', true), '')
        AND
        connection_id IN (
          SELECT id FROM public.channel_connections
          WHERE is_active IS TRUE
            AND webhook_identifier = NULLIF(current_setting('app.webhook_identifier', true), '')::UUID
            AND channel::TEXT = NULLIF(current_setting('app.webhook_provider', true), '')
        )
      );
  END IF;
END $$;

-- 7. Grants
GRANT SELECT, INSERT ON public.provider_events TO ydeck_tenant_runtime_v2;

COMMIT;
