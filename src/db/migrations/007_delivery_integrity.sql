-- Migration 007: inbound completion, outbound delivery, tenant-safe lineage and concurrency.
BEGIN;

ALTER TABLE public.provider_events ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE public.provider_events ADD COLUMN IF NOT EXISTS result_message_id UUID;
ALTER TABLE public.provider_events ADD COLUMN IF NOT EXISTS result_conversation_id UUID;
UPDATE public.provider_events SET completed_at=processed_at
WHERE status='processed' AND completed_at IS NULL AND processed_at IS NOT NULL;
ALTER TABLE public.provider_events DROP CONSTRAINT IF EXISTS provider_events_completion_check;
ALTER TABLE public.provider_events ADD CONSTRAINT provider_events_completion_check
  CHECK (status <> 'processed' OR completed_at IS NOT NULL) NOT VALID;

ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS parent_message_id UUID;
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS provider_message_id TEXT;

-- Composite candidate keys support tenant-safe foreign keys without removing legacy PKs.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.provider_events'::regclass AND conname='provider_events_id_workspace_unique') THEN
    ALTER TABLE public.provider_events ADD CONSTRAINT provider_events_id_workspace_unique UNIQUE(id, workspace_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.messages'::regclass AND conname='messages_id_workspace_unique') THEN
    ALTER TABLE public.messages ADD CONSTRAINT messages_id_workspace_unique UNIQUE(id, workspace_id);
  END IF;
END $$;

-- Existing rows were backfilled in 006. Fail loudly if a conversation mismatch somehow remains.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.messages m JOIN public.conversations c ON c.id=m.conversation_id WHERE m.workspace_id IS DISTINCT FROM c.workspace_id) THEN
    RAISE EXCEPTION 'migration 007 preflight: messages contain unresolved or cross-tenant workspace lineage';
  END IF;
END $$;

ALTER TABLE public.messages ALTER COLUMN workspace_id SET NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.customers'::regclass AND conname='customers_connection_tenant_fk') THEN
    ALTER TABLE public.customers ADD CONSTRAINT customers_connection_tenant_fk
      FOREIGN KEY(connection_id, workspace_id) REFERENCES public.channel_connections(id, workspace_id) ON DELETE RESTRICT NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.conversations'::regclass AND conname='conversations_connection_tenant_fk') THEN
    ALTER TABLE public.conversations ADD CONSTRAINT conversations_connection_tenant_fk
      FOREIGN KEY(connection_id, workspace_id, channel) REFERENCES public.channel_connections(id, workspace_id, channel) ON DELETE RESTRICT NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.messages'::regclass AND conname='messages_conversation_tenant_fk') THEN
    ALTER TABLE public.messages ADD CONSTRAINT messages_conversation_tenant_fk
      FOREIGN KEY(conversation_id, workspace_id) REFERENCES public.conversations(id, workspace_id) ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.messages'::regclass AND conname='messages_provider_event_tenant_fk') THEN
    ALTER TABLE public.messages ADD CONSTRAINT messages_provider_event_tenant_fk
      FOREIGN KEY(provider_event_id, workspace_id) REFERENCES public.provider_events(id, workspace_id) ON DELETE RESTRICT NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.messages'::regclass AND conname='messages_parent_tenant_fk') THEN
    ALTER TABLE public.messages ADD CONSTRAINT messages_parent_tenant_fk
      FOREIGN KEY(parent_message_id, workspace_id) REFERENCES public.messages(id, workspace_id) ON DELETE RESTRICT NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.provider_events'::regclass AND conname='provider_events_result_message_tenant_fk') THEN
    ALTER TABLE public.provider_events ADD CONSTRAINT provider_events_result_message_tenant_fk
      FOREIGN KEY(result_message_id, workspace_id) REFERENCES public.messages(id, workspace_id) ON DELETE RESTRICT NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.provider_events'::regclass AND conname='provider_events_result_conversation_tenant_fk') THEN
    ALTER TABLE public.provider_events ADD CONSTRAINT provider_events_result_conversation_tenant_fk
      FOREIGN KEY(result_conversation_id, workspace_id) REFERENCES public.conversations(id, workspace_id) ON DELETE RESTRICT NOT VALID;
  END IF;
END $$;

ALTER TABLE public.customers VALIDATE CONSTRAINT customers_connection_tenant_fk;
ALTER TABLE public.conversations VALIDATE CONSTRAINT conversations_connection_tenant_fk;
ALTER TABLE public.messages VALIDATE CONSTRAINT messages_conversation_tenant_fk;
ALTER TABLE public.messages VALIDATE CONSTRAINT messages_provider_event_tenant_fk;
ALTER TABLE public.messages VALIDATE CONSTRAINT messages_parent_tenant_fk;
ALTER TABLE public.provider_events VALIDATE CONSTRAINT provider_events_result_message_tenant_fk;
ALTER TABLE public.provider_events VALIDATE CONSTRAINT provider_events_result_conversation_tenant_fk;

-- Nullable paired identity is intentional until ambiguous legacy rows are reconciled.
ALTER TABLE public.customers DROP CONSTRAINT IF EXISTS customers_provider_identity_pair_check;
ALTER TABLE public.customers ADD CONSTRAINT customers_provider_identity_pair_check
  CHECK ((connection_id IS NULL) = (provider_user_id IS NULL)) NOT VALID;
CREATE UNIQUE INDEX IF NOT EXISTS customers_connection_provider_user_unique
  ON public.customers(connection_id, provider_user_id) WHERE connection_id IS NOT NULL AND provider_user_id IS NOT NULL;

-- At most one non-terminal conversation for an identified customer/connection pair.
CREATE UNIQUE INDEX IF NOT EXISTS conversations_one_open_per_connection_customer
  ON public.conversations(connection_id, customer_id)
  WHERE connection_id IS NOT NULL AND status NOT IN ('resolved','closed','spam');

DROP INDEX IF EXISTS public.messages_provider_message_unique;
CREATE INDEX IF NOT EXISTS idx_messages_provider_message
  ON public.messages(workspace_id, provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS messages_provider_event_unique ON public.messages(provider_event_id) WHERE provider_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_parent ON public.messages(parent_message_id) WHERE parent_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_provider_events_recovery ON public.provider_events(status, updated_at)
  WHERE status IN ('received','queued','processing','retryable_failed');

CREATE TABLE IF NOT EXISTS public.outbound_jobs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  connection_id UUID NOT NULL,
  conversation_id UUID NOT NULL,
  message_id UUID NOT NULL,
  idempotency_key TEXT NOT NULL,
  provider public.channel_type NOT NULL,
  recipient_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  provider_message_id TEXT,
  last_error TEXT,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT outbound_jobs_status_check CHECK(status IN ('pending','queued','processing','retryable_failed','sent','permanent_failed','cancelled')),
  CONSTRAINT outbound_jobs_connection_tenant_fk FOREIGN KEY(connection_id, workspace_id) REFERENCES public.channel_connections(id, workspace_id) ON DELETE RESTRICT,
  CONSTRAINT outbound_jobs_conversation_tenant_fk FOREIGN KEY(conversation_id, workspace_id) REFERENCES public.conversations(id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT outbound_jobs_message_tenant_fk FOREIGN KEY(message_id, workspace_id) REFERENCES public.messages(id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT outbound_jobs_workspace_idempotency_unique UNIQUE(workspace_id, idempotency_key),
  CONSTRAINT outbound_jobs_message_unique UNIQUE(message_id)
);
CREATE INDEX IF NOT EXISTS idx_outbound_jobs_claim ON public.outbound_jobs(next_attempt_at, created_at)
  WHERE status IN ('pending','queued','retryable_failed');
CREATE INDEX IF NOT EXISTS idx_outbound_jobs_conversation ON public.outbound_jobs(conversation_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS outbound_jobs_provider_ack_unique
  ON public.outbound_jobs(connection_id, provider_message_id) WHERE provider_message_id IS NOT NULL;

ALTER TABLE public.outbound_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outbound_jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS outbound_job_tenant_policy ON public.outbound_jobs;
CREATE POLICY outbound_job_tenant_policy ON public.outbound_jobs
  USING (public.current_user_is_workspace_member(workspace_id))
  WITH CHECK (public.current_user_is_workspace_member(workspace_id));

-- Replace policies so reruns converge even when an older definition exists.
DROP POLICY IF EXISTS message_tenant_policy ON public.messages;
CREATE POLICY message_tenant_policy ON public.messages
  USING (public.current_user_is_workspace_member(workspace_id))
  WITH CHECK (public.current_user_is_workspace_member(workspace_id));

-- The provider-event ledger may now be completed by the queue worker.
DROP POLICY IF EXISTS provider_event_webhook_policy ON public.provider_events;
CREATE POLICY provider_event_webhook_policy ON public.provider_events FOR INSERT TO ydeck_tenant_runtime_v2
  WITH CHECK (provider::text=NULLIF(current_setting('app.webhook_provider',true),'') AND connection_id IN (
    SELECT id FROM public.channel_connections WHERE is_active IS TRUE
      AND webhook_identifier=NULLIF(current_setting('app.webhook_identifier',true),'')::uuid
      AND channel::text=NULLIF(current_setting('app.webhook_provider',true),'')
  ));

-- Keep one unaccepted invitation per normalized address. Creation paths retire expired
-- rows first; acceptance below now handles an existing membership deterministically.
DROP INDEX IF EXISTS public.workspace_invitations_one_live_email;
CREATE UNIQUE INDEX workspace_invitations_one_live_email
  ON public.workspace_invitations(workspace_id, lower(email))
  WHERE accepted_at IS NULL;

CREATE OR REPLACE FUNCTION public.accept_workspace_invitation(p_token_hash TEXT)
RETURNS TABLE(workspace_id UUID, role user_role) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE actor UUID; invite_id UUID; invite_workspace UUID; invite_role user_role;
BEGIN
 actor:=NULLIF(current_setting('app.user_id',true),'')::UUID;
 IF actor IS NULL THEN RAISE EXCEPTION 'authenticated identity required' USING ERRCODE='28000'; END IF;
 SELECT i.id,i.workspace_id,i.role INTO invite_id,invite_workspace,invite_role
 FROM public.workspace_invitations i JOIN public.users u ON u.id=actor AND lower(u.email)=lower(i.email)
 WHERE i.token_hash=p_token_hash AND i.accepted_at IS NULL AND i.expires_at>NOW() FOR UPDATE OF i;
 IF NOT FOUND THEN RETURN; END IF;
 INSERT INTO public.workspace_members(workspace_id,user_id,role) VALUES(invite_workspace,actor,invite_role)
 ON CONFLICT(workspace_id,user_id) DO UPDATE SET role=EXCLUDED.role;
 UPDATE public.workspace_invitations SET accepted_at=NOW() WHERE id=invite_id;
 workspace_id:=invite_workspace; role:=invite_role; RETURN NEXT;
END $fn$;

COMMIT;
