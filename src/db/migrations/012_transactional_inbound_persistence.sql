-- Issue #59: transactional inbound persistence — one atomic function for the
-- customer upsert + active-conversation resolve/create + inbound-message
-- insert that `AIIntelligenceService.processIncomingMessage` previously ran
-- as three separate statements over the privileged pool connection. Running
-- them as three statements left a real interleaving window: two concurrent
-- inbound runs for the same customer could race between the customer
-- upsert and the conversation lookup.
--
-- This is NOT a reuse of migration 007's upsert_connection_customer() or
-- migration 008's resolve_active_conversation() — both require
-- current_setting('app.user_id') and (for the latter) a workspace_members
-- FOR KEY SHARE check, because they authorize a human, session-bound actor.
-- This function runs on behalf of the system/background worker with no
-- logged-in user: its only trust anchor is p_connection_id, resolved
-- server-side to its workspace_id via a real, active channel_connections
-- row. A connection_id that doesn't resolve to an active connection for the
-- given provider is rejected outright — that rejection IS the tenant
-- boundary here, exactly as in 007/008. No workspace_id is ever accepted
-- from the caller.
--
-- A PL/pgSQL function body is already part of the calling transaction: a
-- RAISE EXCEPTION anywhere below aborts the whole implicit transaction and
-- every statement in it rolls back together. No explicit sub-transaction is
-- introduced (none is needed, and one could allow a partial commit).
--
-- Forward recovery: if this preflight or constraint validation ever fails,
-- inspect the reported aggregates with privileged, access-controlled
-- queries exactly as migrations 007/008 direct. Never auto-delete, merge,
-- or reassign customer/conversation rows from these counts alone; reconcile
-- from authoritative provider records, then rerun this idempotent
-- migration.
BEGIN;

-- This function's WHERE-clause dedup semantics for provider_event_id must
-- match the partial unique index created in migration 009
-- (messages_provider_event_id_unique). No new index is required here.

CREATE OR REPLACE FUNCTION public.persist_inbound_message(
  p_connection_id UUID,
  p_provider public.channel_type,
  p_provider_user_id TEXT,
  p_content TEXT,
  p_message_type TEXT DEFAULT 'text',
  p_full_name TEXT DEFAULT NULL,
  p_username TEXT DEFAULT NULL,
  p_detected_language VARCHAR(10) DEFAULT NULL,
  p_detected_intent VARCHAR(100) DEFAULT NULL,
  p_sentiment VARCHAR(20) DEFAULT NULL,
  p_provider_event_id UUID DEFAULT NULL
) RETURNS TABLE (
  out_customer_id UUID,
  out_conversation_id UUID,
  out_conversation_mode public.control_mode,
  out_conversation_status public.conversation_status,
  out_message_id UUID,
  out_is_duplicate_event BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  derived_workspace UUID;
  derived_channel public.channel_type;
  customer public.customers%ROWTYPE;
  conversation public.conversations%ROWTYPE;
  inserted_message_id UUID;
  event_was_duplicate BOOLEAN := FALSE;
BEGIN
  IF p_connection_id IS NULL OR p_provider IS NULL OR NULLIF(BTRIM(p_provider_user_id), '') IS NULL THEN
    RAISE EXCEPTION 'connection, provider, and provider user identity are required' USING ERRCODE = '22023';
  END IF;
  IF NULLIF(BTRIM(p_content), '') IS NULL THEN
    RAISE EXCEPTION 'message content is required' USING ERRCODE = '22023';
  END IF;

  -- Sole trust anchor: connection_id must resolve to a real, active
  -- channel_connections row for the claimed provider. No caller-supplied
  -- workspace_id is ever accepted or trusted.
  SELECT cc.workspace_id, cc.channel INTO derived_workspace, derived_channel
  FROM public.channel_connections cc
  WHERE cc.id = p_connection_id AND cc.channel = p_provider AND cc.is_active IS TRUE;
  IF derived_workspace IS NULL THEN
    RAISE EXCEPTION 'active provider connection not found' USING ERRCODE = '23503';
  END IF;

  -- 1. Upsert the customer, scoped by (workspace_id, connection_id,
  -- provider_user_id) — same unique index as migration 007's
  -- upsert_connection_customer(), no app.user_id/workspace-membership check.
  INSERT INTO public.customers (
    workspace_id, connection_id, provider_user_id, full_name,
    telegram_id, telegram_username, instagram_id, instagram_username,
    preferred_language, last_contact_at
  ) VALUES (
    derived_workspace, p_connection_id, BTRIM(p_provider_user_id), p_full_name,
    CASE WHEN p_provider = 'telegram' THEN BTRIM(p_provider_user_id) END,
    CASE WHEN p_provider = 'telegram' THEN p_username END,
    CASE WHEN p_provider = 'instagram' THEN BTRIM(p_provider_user_id) END,
    CASE WHEN p_provider = 'instagram' THEN p_username END,
    COALESCE(p_detected_language, 'uz'),
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

  -- 2. Resolve-or-create the active conversation for this
  -- connection+customer+channel — same "one active conversation" invariant
  -- (and the same active-status list) as migration 008's
  -- resolve_active_conversation(), reusing its proven
  -- ON CONFLICT ... DO NOTHING / re-select loop so two concurrent calls for
  -- the same customer can't create two active conversations.
  LOOP
    INSERT INTO public.conversations (
      workspace_id, connection_id, customer_id, channel, status, mode,
      detected_language, detected_intent, sentiment
    ) VALUES (
      derived_workspace, p_connection_id, customer.id, derived_channel, 'new', 'auto',
      p_detected_language, p_detected_intent, p_sentiment
    )
    ON CONFLICT (workspace_id, connection_id, customer_id, channel)
      WHERE connection_id IS NOT NULL AND status IN
        ('new', 'ai_handling', 'waiting_for_customer', 'human_attention_required', 'human_handling', 'qualified_lead')
    DO NOTHING RETURNING * INTO conversation;
    IF FOUND THEN EXIT; END IF;

    SELECT c.* INTO conversation FROM public.conversations c
    WHERE c.workspace_id = derived_workspace AND c.connection_id = p_connection_id
      AND c.customer_id = customer.id AND c.channel = derived_channel
      AND c.status IN ('new', 'ai_handling', 'waiting_for_customer', 'human_attention_required', 'human_handling', 'qualified_lead');
    IF FOUND THEN EXIT; END IF;
  END LOOP;

  -- 3. Insert the inbound customer message, mirroring the exact dedup
  -- semantics already in ai-intelligence.ts: ON CONFLICT on the partial
  -- unique index from migration 009 makes this a no-op for a
  -- redelivered/re-processed provider event rather than a duplicate
  -- customer-facing message.
  INSERT INTO public.messages (conversation_id, sender, content, message_type, delivery_status, provider_event_id)
  VALUES (conversation.id, 'customer', p_content, p_message_type, 'delivered', p_provider_event_id)
  ON CONFLICT (provider_event_id) WHERE provider_event_id IS NOT NULL DO NOTHING
  RETURNING id INTO inserted_message_id;

  IF p_provider_event_id IS NOT NULL AND inserted_message_id IS NULL THEN
    event_was_duplicate := TRUE;
  END IF;

  RETURN QUERY SELECT customer.id, conversation.id, conversation.mode, conversation.status, inserted_message_id, event_was_duplicate;
END $fn$;

REVOKE ALL ON FUNCTION public.persist_inbound_message(
  UUID, public.channel_type, TEXT, TEXT, TEXT, TEXT, TEXT, VARCHAR, VARCHAR, VARCHAR, UUID
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.persist_inbound_message(
  UUID, public.channel_type, TEXT, TEXT, TEXT, TEXT, TEXT, VARCHAR, VARCHAR, VARCHAR, UUID
) TO ydeck_tenant_runtime_v2;

COMMIT;
