-- Issue #58: one active conversation per connection-scoped customer identity.
-- Requires migration 007_connection_scoped_customer_identity.sql.
-- Forward recovery: inspect aggregate failures with privileged, access-controlled queries.
-- Reconcile duplicate active groups explicitly; restore or correct invalid references from
-- authoritative records. Never auto-delete, merge, or reassign. Rerun only at zero counts.
BEGIN;
LOCK TABLE public.conversations IN SHARE ROW EXCLUSIVE MODE;
DO $do$
DECLARE duplicate_active_groups bigint; invalid_connections bigint; invalid_customers bigint;
BEGIN
 SELECT COUNT(*) INTO duplicate_active_groups FROM (
  SELECT 1 FROM public.conversations WHERE connection_id IS NOT NULL AND status IN ('new','ai_handling','waiting_for_customer','human_attention_required','human_handling','qualified_lead')
  GROUP BY workspace_id,connection_id,customer_id,channel HAVING COUNT(*)>1
 ) duplicates;
 SELECT COUNT(*) INTO invalid_connections FROM public.conversations c LEFT JOIN public.channel_connections cc ON cc.id=c.connection_id AND cc.workspace_id=c.workspace_id AND cc.channel=c.channel WHERE c.connection_id IS NOT NULL AND cc.id IS NULL;
 SELECT COUNT(*) INTO invalid_customers FROM public.conversations c LEFT JOIN public.customers customer ON customer.id=c.customer_id AND customer.workspace_id=c.workspace_id AND customer.connection_id=c.connection_id WHERE c.connection_id IS NOT NULL AND customer.id IS NULL;
 IF duplicate_active_groups>0 OR invalid_connections>0 OR invalid_customers>0 THEN
  RAISE EXCEPTION 'migration 008 preflight failed: duplicate active groups=%, invalid connections=%, invalid customers=%',duplicate_active_groups,invalid_connections,invalid_customers;
 END IF;
END $do$;
DO $do$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='channel_connections_id_workspace_channel_unique' AND conrelid='public.channel_connections'::regclass) THEN ALTER TABLE public.channel_connections ADD CONSTRAINT channel_connections_id_workspace_channel_unique UNIQUE(id,workspace_id,channel); END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='customers_id_workspace_connection_unique' AND conrelid='public.customers'::regclass) THEN ALTER TABLE public.customers ADD CONSTRAINT customers_id_workspace_connection_unique UNIQUE(id,workspace_id,connection_id); END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='conversations_connection_channel_tenant_fk' AND conrelid='public.conversations'::regclass) THEN ALTER TABLE public.conversations ADD CONSTRAINT conversations_connection_channel_tenant_fk FOREIGN KEY(connection_id,workspace_id,channel) REFERENCES public.channel_connections(id,workspace_id,channel) NOT VALID; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='conversations_customer_connection_fk' AND conrelid='public.conversations'::regclass) THEN ALTER TABLE public.conversations ADD CONSTRAINT conversations_customer_connection_fk FOREIGN KEY(customer_id,workspace_id,connection_id) REFERENCES public.customers(id,workspace_id,connection_id) NOT VALID; END IF;
END $do$;
ALTER TABLE public.conversations VALIDATE CONSTRAINT conversations_connection_channel_tenant_fk;
ALTER TABLE public.conversations VALIDATE CONSTRAINT conversations_customer_connection_fk;
CREATE UNIQUE INDEX IF NOT EXISTS conversations_one_active_connection_customer ON public.conversations(workspace_id,connection_id,customer_id,channel) WHERE connection_id IS NOT NULL AND status IN ('new','ai_handling','waiting_for_customer','human_attention_required','human_handling','qualified_lead');
CREATE OR REPLACE FUNCTION public.resolve_active_conversation(p_connection_id UUID,p_customer_id UUID)
RETURNS public.conversations LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE actor UUID; derived_workspace UUID; derived_channel public.channel_type; conversation public.conversations%ROWTYPE;
BEGIN
 actor:=NULLIF(current_setting('app.user_id',true),'')::UUID;
 IF actor IS NULL THEN RAISE EXCEPTION 'authenticated identity required' USING ERRCODE='28000'; END IF;
 IF p_connection_id IS NULL OR p_customer_id IS NULL THEN RAISE EXCEPTION 'connection and customer are required' USING ERRCODE='22023'; END IF;
 SELECT cc.workspace_id,cc.channel INTO derived_workspace,derived_channel FROM public.channel_connections cc WHERE cc.id=p_connection_id AND cc.is_active IS TRUE;
 IF derived_workspace IS NULL THEN RAISE EXCEPTION 'active provider connection not found' USING ERRCODE='23503'; END IF;
 IF NOT public.current_user_is_workspace_member(derived_workspace) THEN RAISE EXCEPTION 'workspace access denied' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.customers c WHERE c.id=p_customer_id AND c.workspace_id=derived_workspace AND c.connection_id=p_connection_id) THEN RAISE EXCEPTION 'connection-scoped customer not found' USING ERRCODE='23503'; END IF;
 INSERT INTO public.conversations(workspace_id,connection_id,customer_id,channel,status) VALUES(derived_workspace,p_connection_id,p_customer_id,derived_channel,'new')
 ON CONFLICT(workspace_id,connection_id,customer_id,channel) WHERE connection_id IS NOT NULL AND status IN ('new','ai_handling','waiting_for_customer','human_attention_required','human_handling','qualified_lead')
 DO UPDATE SET last_message_at=public.conversations.last_message_at RETURNING * INTO conversation;
 RETURN conversation;
END $fn$;
REVOKE ALL ON FUNCTION public.resolve_active_conversation(UUID,UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_active_conversation(UUID,UUID) TO ydeck_tenant_runtime_v2;
REVOKE INSERT,UPDATE,DELETE ON public.conversations FROM ydeck_tenant_runtime_v2;
GRANT SELECT ON public.conversations TO ydeck_tenant_runtime_v2;
GRANT UPDATE(status,summary) ON public.conversations TO ydeck_tenant_runtime_v2;
COMMIT;
