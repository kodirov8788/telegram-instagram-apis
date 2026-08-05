-- Migration 009: prepare an explicit, operator-controlled legacy identity gate.
--
-- This migration is deliberately separate from 010. Apply it first, populate the
-- two tables below for every legacy row that 006 could not resolve safely, review
-- the mappings, and only then apply 010. No application role may read these tables.
BEGIN;

CREATE SCHEMA IF NOT EXISTS ydeck_migration;
REVOKE ALL ON SCHEMA ydeck_migration FROM PUBLIC;

CREATE TABLE IF NOT EXISTS ydeck_migration.customer_identity_reconciliation (
  customer_id UUID PRIMARY KEY REFERENCES public.customers(id) ON DELETE CASCADE,
  connection_id UUID NOT NULL REFERENCES public.channel_connections(id) ON DELETE RESTRICT,
  provider_user_id TEXT NOT NULL CHECK (length(provider_user_id) > 0),
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ydeck_migration.conversation_connection_reconciliation (
  conversation_id UUID PRIMARY KEY REFERENCES public.conversations(id) ON DELETE CASCADE,
  connection_id UUID NOT NULL REFERENCES public.channel_connections(id) ON DELETE RESTRICT,
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

REVOKE ALL ON ALL TABLES IN SCHEMA ydeck_migration FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA ydeck_migration FROM PUBLIC;

COMMIT;
