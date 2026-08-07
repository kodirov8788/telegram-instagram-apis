-- Migration 009: provider event ledger for inbound webhook idempotency.
-- Every inbound webhook delivery is recorded here before enqueueing so a
-- redelivered webhook (Telegram/Meta retries, or a worker re-reading a
-- still-visible queue message) can be deduplicated by
-- (connection_id, provider_event_id) instead of reprocessed.
BEGIN;

CREATE TABLE IF NOT EXISTS public.provider_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
    connection_id UUID NOT NULL,
    provider public.channel_type NOT NULL,
    provider_event_id VARCHAR(255) NOT NULL,
    payload JSONB NOT NULL,
    payload_hash CHAR(64) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'received',
    attempts INTEGER NOT NULL DEFAULT 0,
    processed_at TIMESTAMP WITH TIME ZONE,
    last_error TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT provider_events_status_check
        CHECK (status IN ('received', 'queued', 'processing', 'processed', 'retryable_failed', 'permanent_failed'))
);

DO $do$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'provider_events_connection_tenant_fk' AND conrelid = 'public.provider_events'::regclass
    ) THEN
        ALTER TABLE public.provider_events
            ADD CONSTRAINT provider_events_connection_tenant_fk
            FOREIGN KEY (connection_id, workspace_id, provider)
            REFERENCES public.channel_connections(id, workspace_id, channel)
            ON DELETE CASCADE;
    END IF;
END $do$;

-- Dedup key: the same provider event id can legitimately repeat across
-- different connections (two workspaces on the same shared dev bot, for
-- example), but never twice for the same connection.
CREATE UNIQUE INDEX IF NOT EXISTS provider_events_connection_event_unique
    ON public.provider_events (connection_id, provider_event_id);

CREATE INDEX IF NOT EXISTS idx_provider_events_status ON public.provider_events(status);
CREATE INDEX IF NOT EXISTS idx_provider_events_workspace_id ON public.provider_events(workspace_id);

-- Second dedup layer at the message level, for the (rarer) case where a
-- provider event was already marked processed but the worker crashed
-- before that status write committed — re-processing must not double-insert
-- the customer-facing message.
CREATE UNIQUE INDEX IF NOT EXISTS messages_provider_event_id_unique
    ON public.messages (provider_event_id) WHERE provider_event_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE ON public.provider_events TO ydeck_tenant_runtime_v2;

COMMIT;
