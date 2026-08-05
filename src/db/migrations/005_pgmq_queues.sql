-- Migration 005: pgmq extension and queues setup
BEGIN;

-- 1. Preflight check: Verify extension availability
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_available_extensions WHERE name = 'pgmq'
  ) THEN
    RAISE EXCEPTION 'Preflight failed: pgmq extension is not available in pg_available_extensions';
  END IF;
END $$;

-- 2. Install extension
CREATE EXTENSION IF NOT EXISTS pgmq;

-- 3. Verify installed extension version is compatible (v1.x)
DO $$
DECLARE
  ext_ver TEXT;
BEGIN
  SELECT extversion INTO ext_ver FROM pg_extension WHERE extname = 'pgmq';
  IF ext_ver IS NULL THEN
    RAISE EXCEPTION 'Preflight failed: pgmq extension was not successfully installed';
  END IF;
  IF NOT (ext_ver LIKE '1.%') THEN
    RAISE EXCEPTION 'Preflight failed: Incompatible pgmq extension version % (expected v1.x)', ext_ver;
  END IF;
END $$;

-- 4. Create queues if they do not exist (idempotent/rerun safe)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'pgmq' AND tablename = 'q_inbound_events') THEN
    EXECUTE 'SELECT pgmq.create(''inbound_events'')';
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'pgmq' AND tablename = 'q_outbound_messages') THEN
    EXECUTE 'SELECT pgmq.create(''outbound_messages'')';
  END IF;
END $$;

-- 5. Revoke default PUBLIC / PostgREST / anon / authenticated exposure on pgmq
DO $$
BEGIN
  -- Revoke from PUBLIC
  REVOKE ALL ON SCHEMA pgmq FROM PUBLIC;
  REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pgmq FROM PUBLIC;
  REVOKE ALL ON ALL TABLES IN SCHEMA pgmq FROM PUBLIC;

  -- Revoke from anon if exists
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON SCHEMA pgmq FROM anon';
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA pgmq FROM anon';
    EXECUTE 'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pgmq FROM anon';
  END IF;

  -- Revoke from authenticated if exists
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON SCHEMA pgmq FROM authenticated';
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA pgmq FROM authenticated';
    EXECUTE 'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pgmq FROM authenticated';
  END IF;
END $$;

-- 6. Setup wrapper schema ydeck_queue and functions
CREATE SCHEMA IF NOT EXISTS ydeck_queue;

CREATE OR REPLACE FUNCTION ydeck_queue.send(
  queue_name text,
  msg jsonb,
  delay integer DEFAULT 0
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pgmq, pg_catalog, pg_temp
AS $$
BEGIN
  IF queue_name NOT IN ('inbound_events', 'outbound_messages') THEN
    RAISE EXCEPTION 'Invalid queue name: %', queue_name;
  END IF;
  
  IF delay IS NULL OR delay < 0 THEN
    RAISE EXCEPTION 'Delay must be an integer >= 0';
  END IF;

  RETURN pgmq.send(queue_name, msg, delay);
END;
$$;

CREATE OR REPLACE FUNCTION ydeck_queue.read(
  queue_name text,
  visibility_timeout integer,
  qty integer,
  conditional jsonb DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  msg_id bigint,
  read_ct integer,
  enqueued_at timestamp with time zone,
  vt timestamp with time zone,
  message jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pgmq, pg_catalog, pg_temp
AS $$
BEGIN
  IF queue_name NOT IN ('inbound_events', 'outbound_messages') THEN
    RAISE EXCEPTION 'Invalid queue name: %', queue_name;
  END IF;

  IF visibility_timeout IS NULL OR visibility_timeout < 1 THEN
    RAISE EXCEPTION 'Visibility timeout must be an integer >= 1';
  END IF;
  IF qty IS NULL OR qty < 1 OR qty > 5 THEN
    RAISE EXCEPTION 'Batch limit must be an integer between 1 and 5';
  END IF;

  RETURN QUERY
  SELECT r.msg_id, r.read_ct, r.enqueued_at, r.vt, r.message
  FROM pgmq.read(queue_name, visibility_timeout, qty, conditional) AS r;
END;
$$;

CREATE OR REPLACE FUNCTION ydeck_queue.delete(
  queue_name text,
  msg_id bigint
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pgmq, pg_catalog, pg_temp
AS $$
BEGIN
  IF queue_name NOT IN ('inbound_events', 'outbound_messages') THEN
    RAISE EXCEPTION 'Invalid queue name: %', queue_name;
  END IF;
  RETURN pgmq.delete(queue_name, msg_id);
END;
$$;

CREATE OR REPLACE FUNCTION ydeck_queue.archive(
  queue_name text,
  msg_id bigint
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pgmq, pg_catalog, pg_temp
AS $$
BEGIN
  IF queue_name NOT IN ('inbound_events', 'outbound_messages') THEN
    RAISE EXCEPTION 'Invalid queue name: %', queue_name;
  END IF;
  RETURN pgmq.archive(queue_name, msg_id);
END;
$$;

-- 7. Grant wrapper owner/deploy role the exact underlying privileges
GRANT USAGE ON SCHEMA pgmq TO CURRENT_USER;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE pgmq.q_inbound_events TO CURRENT_USER;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE pgmq.q_outbound_messages TO CURRENT_USER;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE pgmq.a_inbound_events TO CURRENT_USER;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE pgmq.a_outbound_messages TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION pgmq.send(text, jsonb, integer) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION pgmq.read(text, integer, integer, jsonb) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION pgmq.delete(text, bigint) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION pgmq.archive(text, bigint) TO CURRENT_USER;

-- 8. Revoke ydeck_queue exposure from PUBLIC, anon, and authenticated
REVOKE ALL ON SCHEMA ydeck_queue FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ydeck_queue FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON SCHEMA ydeck_queue FROM anon';
    EXECUTE 'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ydeck_queue FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON SCHEMA ydeck_queue FROM authenticated';
    EXECUTE 'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ydeck_queue FROM authenticated';
  END IF;
END $$;

-- 9. Grant narrow access to the application's runtime tenant role
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ydeck_tenant_runtime_v2') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA ydeck_queue TO ydeck_tenant_runtime_v2';
    EXECUTE 'GRANT EXECUTE ON FUNCTION ydeck_queue.send(text, jsonb, integer) TO ydeck_tenant_runtime_v2';
    EXECUTE 'GRANT EXECUTE ON FUNCTION ydeck_queue.read(text, integer, integer, jsonb) TO ydeck_tenant_runtime_v2';
    EXECUTE 'GRANT EXECUTE ON FUNCTION ydeck_queue.delete(text, bigint) TO ydeck_tenant_runtime_v2';
    EXECUTE 'GRANT EXECUTE ON FUNCTION ydeck_queue.archive(text, bigint) TO ydeck_tenant_runtime_v2';
  END IF;
END $$;

COMMIT;
