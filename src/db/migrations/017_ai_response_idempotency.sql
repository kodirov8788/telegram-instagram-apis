-- Issue #74: idempotent AI-generated response per provider_events row.
--
-- `messages.provider_event_id` (migration 009) already prevents a duplicate
-- *inbound customer* message from being inserted twice for the same
-- provider event, via a partial unique index checked with
-- ON CONFLICT ... DO NOTHING in persist_inbound_message() (migration 012).
--
-- That does NOT prevent a second *AI-generated* message (and, for 'auto'
-- mode, a second outbound_job) from being created for the same provider
-- event on a retry: `processInboundEvent` (src/lib/workers/processors/
-- inbound.ts) claims a provider_events row, runs the full AI pipeline
-- (classify -> persist inbound message -> generate reply -> insert AI
-- message [+ job + enqueue for 'auto']), then marks the row 'processed' in
-- a separate, final UPDATE. A crash after the AI-generation transaction
-- commits but before that final UPDATE leaves the row reclaimable
-- ('queued'/'retryable_failed'/stale 'processing'); a retry re-runs the
-- whole pipeline and generates a SECOND AI reply for the same original
-- customer message.
--
-- Fix: a distinct column, source_provider_event_id, marks the
-- provider_events.id that CAUSED an AI-generated message to be created
-- (auto pending message, approval draft, or suggestion) — separate from
-- provider_event_id, which marks the INBOUND customer message itself. A
-- message can carry both, one, or neither, since customer messages and
-- AI-generated messages are different rows. A partial unique index mirrors
-- migration 009 exactly, and every AI-generation insert path in
-- ai-intelligence.ts sets this column and checks the index via
-- ON CONFLICT ... DO NOTHING inside the same atomic transaction that
-- already creates the message (and, for 'auto' mode, the outbound_job and
-- enqueue) — additive to the #46 atomicity fix, not a separate step.

BEGIN;

ALTER TABLE public.messages
    ADD COLUMN IF NOT EXISTS source_provider_event_id UUID;

CREATE UNIQUE INDEX IF NOT EXISTS messages_source_provider_event_id_unique
    ON public.messages (source_provider_event_id) WHERE source_provider_event_id IS NOT NULL;

COMMENT ON COLUMN public.messages.source_provider_event_id IS
    'provider_events.id that caused this AI-generated message to be created (auto/approval/suggestion). Distinct from provider_event_id, which marks an inbound customer message. Partial-unique: at most one generated message per provider event, making inbound-worker retries idempotent (issue #74).';

COMMIT;
