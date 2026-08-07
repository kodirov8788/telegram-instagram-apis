-- Migration 010: durable inbound event queue via Supabase's pgmq extension.
--
-- Scope: a single queue, `inbound_events`, carrying only
-- { v: 1, providerEventId: <uuid> } payloads. Application code never talks
-- to pgmq directly — it goes through the `ydeck_queue` wrapper functions
-- below, which whitelist the queue name and validate parameters, and are
-- the only pgmq-adjacent objects granted to the runtime role.
BEGIN;

DO $do$
DECLARE pgmq_version text;
BEGIN
    SELECT extversion INTO pgmq_version FROM pg_available_extensions WHERE name = 'pgmq';
    IF pgmq_version IS NULL THEN
        RAISE EXCEPTION 'pgmq extension is not available on this Postgres instance';
    END IF;
    IF split_part(pgmq_version, '.', 1)::int NOT IN (1) THEN
        RAISE EXCEPTION 'unexpected pgmq major version %; verify compatibility before proceeding', pgmq_version;
    END IF;
END $do$;

CREATE EXTENSION IF NOT EXISTS pgmq;

SELECT pgmq.create('inbound_events') WHERE NOT EXISTS (
    SELECT 1 FROM pgmq.list_queues() WHERE queue_name = 'inbound_events'
);

-- pgmq's own tables/functions are not exposed to the runtime role directly —
-- only through the narrow wrapper below, which whitelists the queue name so
-- a compromised or buggy caller can't address arbitrary pgmq queues (there
-- are none besides inbound_events today, but this keeps that invariant
-- enforced at the DB layer rather than only in application code).
CREATE SCHEMA IF NOT EXISTS ydeck_queue;

CREATE OR REPLACE FUNCTION ydeck_queue.send(p_queue text, p_message jsonb, p_delay integer DEFAULT 0)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pgmq, public
AS $fn$
BEGIN
    IF p_queue <> 'inbound_events' THEN
        RAISE EXCEPTION 'unknown queue: %', p_queue;
    END IF;
    IF p_delay IS NULL OR p_delay < 0 THEN
        RAISE EXCEPTION 'delay must be >= 0';
    END IF;
    RETURN pgmq.send(p_queue, p_message, p_delay);
END;
$fn$;

CREATE OR REPLACE FUNCTION ydeck_queue.read(p_queue text, p_visibility_timeout integer, p_qty integer)
RETURNS TABLE(msg_id bigint, read_ct integer, enqueued_at timestamptz, vt timestamptz, message jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pgmq, public
AS $fn$
BEGIN
    IF p_queue <> 'inbound_events' THEN
        RAISE EXCEPTION 'unknown queue: %', p_queue;
    END IF;
    IF p_visibility_timeout IS NULL OR p_visibility_timeout < 1 THEN
        RAISE EXCEPTION 'visibility timeout must be >= 1';
    END IF;
    IF p_qty IS NULL OR p_qty < 1 OR p_qty > 5 THEN
        RAISE EXCEPTION 'batch quantity must be between 1 and 5';
    END IF;
    RETURN QUERY SELECT * FROM pgmq.read(p_queue, p_visibility_timeout, p_qty);
END;
$fn$;

CREATE OR REPLACE FUNCTION ydeck_queue.delete(p_queue text, p_msg_id bigint)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pgmq, public
AS $fn$
BEGIN
    IF p_queue <> 'inbound_events' THEN
        RAISE EXCEPTION 'unknown queue: %', p_queue;
    END IF;
    RETURN pgmq.delete(p_queue, p_msg_id);
END;
$fn$;

CREATE OR REPLACE FUNCTION ydeck_queue.archive(p_queue text, p_msg_id bigint)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pgmq, public
AS $fn$
BEGIN
    IF p_queue <> 'inbound_events' THEN
        RAISE EXCEPTION 'unknown queue: %', p_queue;
    END IF;
    RETURN pgmq.archive(p_queue, p_msg_id);
END;
$fn$;

REVOKE ALL ON SCHEMA pgmq FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA pgmq FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pgmq FROM PUBLIC;

GRANT USAGE ON SCHEMA ydeck_queue TO ydeck_tenant_runtime_v2;
GRANT EXECUTE ON FUNCTION ydeck_queue.send(text, jsonb, integer) TO ydeck_tenant_runtime_v2;
GRANT EXECUTE ON FUNCTION ydeck_queue.read(text, integer, integer) TO ydeck_tenant_runtime_v2;
GRANT EXECUTE ON FUNCTION ydeck_queue.delete(text, bigint) TO ydeck_tenant_runtime_v2;
GRANT EXECUTE ON FUNCTION ydeck_queue.archive(text, bigint) TO ydeck_tenant_runtime_v2;

COMMIT;
