-- Migration 013: outbound job persistence/state machine (issue #45).
--
-- Scope: durably record outbound send *intent* before any provider call is
-- attempted, and give the future outbound worker (#46) a concurrency-safe
-- claim/transition model to build on — mirroring the atomic
-- claim-via-conditional-UPDATE pattern already used for `provider_events`
-- (migration 009 / src/lib/workers/processors/inbound.ts).
--
-- This migration does NOT wire anything into ai-intelligence.ts and does
-- NOT implement a worker — it only creates the table + constraints. See
-- src/lib/services/outbound-jobs.ts for the application-level boundary.
BEGIN;

CREATE TABLE IF NOT EXISTS public.outbound_jobs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
    connection_id UUID NOT NULL,
    channel public.channel_type NOT NULL,
    message_id UUID NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
    recipient_id TEXT NOT NULL,
    content TEXT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    provider_message_id VARCHAR(255),
    last_error TEXT,
    next_attempt_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    sent_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    -- Required states per issue #45, plus 'ambiguous' for "the provider call
    -- was made but its outcome is unknown" (network failure after dispatch,
    -- before we got a response) — consistent with prior-art reasoning on
    -- feat/issue-56-inbound-data-preflight (commits 1c34d4f / 85a867b,
    -- "prevent ambiguous outbound redelivery" / "distinguish rejected and
    -- ambiguous sends"), not currently merged into this table but kept as
    -- the reference design so #46 can build the same recovery semantics.
    CONSTRAINT outbound_jobs_status_check
        CHECK (status IN ('pending', 'processing', 'sent', 'retryable_failed', 'permanent_failed', 'ambiguous'))
);

DO $do$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'outbound_jobs_connection_tenant_fk' AND conrelid = 'public.outbound_jobs'::regclass
    ) THEN
        ALTER TABLE public.outbound_jobs
            ADD CONSTRAINT outbound_jobs_connection_tenant_fk
            FOREIGN KEY (connection_id, workspace_id, channel)
            REFERENCES public.channel_connections (id, workspace_id, channel)
            ON DELETE CASCADE;
    END IF;
END $do$;

-- One logical outbound operation == one message being dispatched. A message
-- must never have more than one concurrently-ACTIVE job (active = anything
-- that isn't a terminal outcome: pending/processing/retryable_failed can
-- still send; sent/permanent_failed/ambiguous are terminal for this table's
-- purposes — ambiguous requires an operator/#46 decision, not an automatic
-- duplicate job). Enforced by the DB, not application discipline.
CREATE UNIQUE INDEX IF NOT EXISTS outbound_jobs_message_active_unique
    ON public.outbound_jobs (message_id)
    WHERE status IN ('pending', 'processing', 'retryable_failed');

-- Claim/poll access patterns: "give me claimable work" (status + due time)
-- and per-tenant/per-message lookups.
CREATE INDEX IF NOT EXISTS idx_outbound_jobs_claimable
    ON public.outbound_jobs (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_outbound_jobs_workspace_id
    ON public.outbound_jobs (workspace_id);
CREATE INDEX IF NOT EXISTS idx_outbound_jobs_message_id
    ON public.outbound_jobs (message_id);

GRANT SELECT, INSERT, UPDATE ON public.outbound_jobs TO ydeck_tenant_runtime_v2;

COMMIT;
