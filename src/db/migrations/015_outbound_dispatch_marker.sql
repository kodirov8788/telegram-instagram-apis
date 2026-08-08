-- Migration 015: ambiguous-delivery protection for outbound_jobs (issue #46).
--
-- Problem: without a durable marker recorded BEFORE the provider call, a
-- worker crash between "called the provider" and "recorded the result"
-- means a reclaimed job (see outbound-jobs.ts's 10-minute stale-processing
-- reclaim) could blindly resend a message the provider may have already
-- delivered. `dispatched_at` closes that gap: the worker sets it, via an
-- atomic conditional UPDATE, immediately before making the provider call
-- and never before. On reclaim, a job found with `dispatched_at IS NOT
-- NULL` and no `provider_message_id` recorded is treated as an unconfirmed
-- prior attempt and routed straight to `ambiguous` instead of ever calling
-- the provider again.
BEGIN;

ALTER TABLE public.outbound_jobs ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMP WITH TIME ZONE;

COMMENT ON COLUMN public.outbound_jobs.dispatched_at IS
    'Set immediately before the provider call is made (atomic UPDATE ... WHERE dispatched_at IS NULL). '
    'A job reclaimed with dispatched_at set and no provider_message_id is an unconfirmed prior attempt: '
    'the worker must transition it to ambiguous rather than calling the provider again.';

COMMIT;
