-- Migration 011: draft review state for AI Response Control Modes (ISSUE-11).
--
-- No change to `conversations.mode` (the control_mode enum already has all
-- four values) or to `messages.delivery_status` (already free-text, so the
-- new conventional values 'pending_approval' | 'suggested' | 'stale' |
-- 'rejected' need no schema change there). Only additive review-tracking
-- columns are needed.
BEGIN;

ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

-- Speeds up "list pending drafts/suggestions for this conversation" and the
-- stale-supersession UPDATE (mark prior drafts stale when a new one lands).
CREATE INDEX IF NOT EXISTS idx_messages_conversation_review_state
    ON public.messages (conversation_id, delivery_status)
    WHERE delivery_status IN ('pending_approval', 'suggested');

COMMIT;
