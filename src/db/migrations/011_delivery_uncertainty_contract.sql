-- Migration 011: persist the provider-dispatch boundary and uncertain outcomes.
BEGIN;

ALTER TABLE public.outbound_jobs
  ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMPTZ;

ALTER TABLE public.outbound_jobs
  DROP CONSTRAINT IF EXISTS outbound_jobs_status_check;
ALTER TABLE public.outbound_jobs
  ADD CONSTRAINT outbound_jobs_status_check
  CHECK (status IN (
    'pending','queued','processing','retryable_failed','sent',
    'permanent_failed','cancelled','ambiguous'
  )) NOT VALID;
ALTER TABLE public.outbound_jobs
  VALIDATE CONSTRAINT outbound_jobs_status_check;

ALTER TABLE public.messages
  DROP CONSTRAINT IF EXISTS messages_delivery_status_check;
ALTER TABLE public.messages
  ADD CONSTRAINT messages_delivery_status_check
  CHECK (delivery_status IN ('pending','sent','delivered','failed','unknown')) NOT VALID;
ALTER TABLE public.messages
  VALIDATE CONSTRAINT messages_delivery_status_check;

CREATE INDEX IF NOT EXISTS idx_outbound_jobs_ambiguous
  ON public.outbound_jobs(dispatched_at, created_at)
  WHERE status = 'ambiguous';

COMMIT;
