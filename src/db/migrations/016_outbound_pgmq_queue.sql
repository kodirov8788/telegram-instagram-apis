-- Migration 016: widen the pgmq wrapper functions to support an
-- `outbound_jobs` queue alongside `inbound_events` (issue #46).
--
-- Does NOT edit migration 010 (already shipped) — instead, CREATE OR
-- REPLACE the same four `ydeck_queue.*` SECURITY DEFINER wrapper functions
-- with a widened whitelist, matching this repo's established pattern for
-- evolving these functions (see migration 014 doing the same for
-- get_connection_secret). Same SECURITY DEFINER / search_path / grant
-- shape as 010; only the whitelist check changes.
BEGIN;

SELECT pgmq.create('outbound_jobs') WHERE NOT EXISTS (
    SELECT 1 FROM pgmq.list_queues() WHERE queue_name = 'outbound_jobs'
);

CREATE OR REPLACE FUNCTION ydeck_queue.send(p_queue text, p_message jsonb, p_delay integer DEFAULT 0)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pgmq, public
AS $fn$
BEGIN
    IF p_queue NOT IN ('inbound_events', 'outbound_jobs') THEN
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
    IF p_queue NOT IN ('inbound_events', 'outbound_jobs') THEN
        RAISE EXCEPTION 'unknown queue: %', p_queue;
    END IF;
    IF p_visibility_timeout IS NULL OR p_visibility_timeout < 1 THEN
        RAISE EXCEPTION 'visibility timeout must be >= 1';
    END IF;
    IF p_qty IS NULL OR p_qty < 1 OR p_qty > 5 THEN
        RAISE EXCEPTION 'batch quantity must be between 1 and 5';
    END IF;
    RETURN QUERY SELECT r.msg_id, r.read_ct, r.enqueued_at, r.vt, r.message FROM pgmq.read(p_queue, p_visibility_timeout, p_qty) r;
END;
$fn$;

CREATE OR REPLACE FUNCTION ydeck_queue.delete(p_queue text, p_msg_id bigint)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pgmq, public
AS $fn$
BEGIN
    IF p_queue NOT IN ('inbound_events', 'outbound_jobs') THEN
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
    IF p_queue NOT IN ('inbound_events', 'outbound_jobs') THEN
        RAISE EXCEPTION 'unknown queue: %', p_queue;
    END IF;
    RETURN pgmq.archive(p_queue, p_msg_id);
END;
$fn$;

-- Grants are unchanged (already granted on the schema/functions in 010);
-- CREATE OR REPLACE preserves existing grants on these function objects.

COMMIT;
