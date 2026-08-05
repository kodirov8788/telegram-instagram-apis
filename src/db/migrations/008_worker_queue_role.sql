-- Migration 008: dedicated least-privilege database role for queue workers.
BEGIN;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ydeck_queue_worker_v1') THEN
    CREATE ROLE ydeck_queue_worker_v1 NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ydeck_queue_worker_v1' AND (rolcanlogin OR rolinherit OR rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication)) THEN
    RAISE EXCEPTION 'unsafe attributes on ydeck_queue_worker_v1';
  END IF;
END $$;
GRANT ydeck_queue_worker_v1 TO CURRENT_USER;

-- Runtime request handlers may enqueue but cannot claim or acknowledge work.
REVOKE EXECUTE ON FUNCTION ydeck_queue.read(text,integer,integer,jsonb) FROM ydeck_tenant_runtime_v2;
REVOKE EXECUTE ON FUNCTION ydeck_queue.delete(text,bigint) FROM ydeck_tenant_runtime_v2;
REVOKE EXECUTE ON FUNCTION ydeck_queue.archive(text,bigint) FROM ydeck_tenant_runtime_v2;
GRANT USAGE ON SCHEMA ydeck_queue TO ydeck_queue_worker_v1;
GRANT EXECUTE ON FUNCTION ydeck_queue.send(text,jsonb,integer) TO ydeck_queue_worker_v1;
GRANT EXECUTE ON FUNCTION ydeck_queue.read(text,integer,integer,jsonb) TO ydeck_queue_worker_v1;
GRANT EXECUTE ON FUNCTION ydeck_queue.delete(text,bigint) TO ydeck_queue_worker_v1;
GRANT EXECUTE ON FUNCTION ydeck_queue.archive(text,bigint) TO ydeck_queue_worker_v1;

GRANT USAGE ON SCHEMA public TO ydeck_queue_worker_v1;
GRANT EXECUTE ON FUNCTION public.current_user_is_workspace_member(UUID) TO ydeck_queue_worker_v1;
GRANT SELECT,UPDATE ON public.provider_events TO ydeck_queue_worker_v1;
GRANT SELECT,INSERT,UPDATE ON public.customers,public.conversations,public.messages,public.outbound_jobs TO ydeck_queue_worker_v1;
GRANT SELECT ON public.channel_connections TO ydeck_queue_worker_v1;

-- Worker access is scoped by an explicit workspace GUC and remains subject to forced RLS.
DROP POLICY IF EXISTS provider_event_worker_policy ON public.provider_events;
CREATE POLICY provider_event_worker_policy ON public.provider_events TO ydeck_queue_worker_v1
  USING (workspace_id=NULLIF(current_setting('app.workspace_id',true),'')::uuid)
  WITH CHECK (workspace_id=NULLIF(current_setting('app.workspace_id',true),'')::uuid);
DROP POLICY IF EXISTS customer_worker_policy ON public.customers;
CREATE POLICY customer_worker_policy ON public.customers TO ydeck_queue_worker_v1 USING (workspace_id=NULLIF(current_setting('app.workspace_id',true),'')::uuid) WITH CHECK (workspace_id=NULLIF(current_setting('app.workspace_id',true),'')::uuid);
DROP POLICY IF EXISTS conversation_worker_policy ON public.conversations;
CREATE POLICY conversation_worker_policy ON public.conversations TO ydeck_queue_worker_v1 USING (workspace_id=NULLIF(current_setting('app.workspace_id',true),'')::uuid) WITH CHECK (workspace_id=NULLIF(current_setting('app.workspace_id',true),'')::uuid);
DROP POLICY IF EXISTS message_worker_policy ON public.messages;
CREATE POLICY message_worker_policy ON public.messages TO ydeck_queue_worker_v1 USING (workspace_id=NULLIF(current_setting('app.workspace_id',true),'')::uuid) WITH CHECK (workspace_id=NULLIF(current_setting('app.workspace_id',true),'')::uuid);
DROP POLICY IF EXISTS outbound_job_worker_policy ON public.outbound_jobs;
CREATE POLICY outbound_job_worker_policy ON public.outbound_jobs TO ydeck_queue_worker_v1 USING (workspace_id=NULLIF(current_setting('app.workspace_id',true),'')::uuid) WITH CHECK (workspace_id=NULLIF(current_setting('app.workspace_id',true),'')::uuid);
DROP POLICY IF EXISTS channel_worker_policy ON public.channel_connections;
CREATE POLICY channel_worker_policy ON public.channel_connections TO ydeck_queue_worker_v1 USING (workspace_id=NULLIF(current_setting('app.workspace_id',true),'')::uuid);

COMMIT;
