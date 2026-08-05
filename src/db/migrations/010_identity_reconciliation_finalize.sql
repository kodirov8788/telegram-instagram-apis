-- Migration 010: apply reviewed legacy mappings and converge with fresh installs.
-- Apply only after 009 and the operator reconciliation described in README.md.
BEGIN;

-- Reject the whole batch before modifying production rows. Diagnostics contain
-- counts only: tenant, customer, conversation, and provider identifiers stay out
-- of migration logs.
DO $$
DECLARE
  invalid_customers BIGINT;
  invalid_conversations BIGINT;
BEGIN
  SELECT COUNT(*) INTO invalid_customers
  FROM ydeck_migration.customer_identity_reconciliation r
  JOIN public.customers c ON c.id = r.customer_id
  JOIN public.channel_connections cc ON cc.id = r.connection_id
  WHERE cc.workspace_id <> c.workspace_id
     OR (c.connection_id IS NOT NULL AND c.connection_id <> r.connection_id)
     OR (c.provider_user_id IS NOT NULL AND c.provider_user_id <> r.provider_user_id);

  SELECT COUNT(*) INTO invalid_conversations
  FROM ydeck_migration.conversation_connection_reconciliation r
  JOIN public.conversations c ON c.id = r.conversation_id
  JOIN public.channel_connections cc ON cc.id = r.connection_id
  JOIN public.customers customer ON customer.id = c.customer_id
  LEFT JOIN ydeck_migration.customer_identity_reconciliation customer_r
    ON customer_r.customer_id = customer.id
  WHERE cc.workspace_id <> c.workspace_id
     OR cc.channel <> c.channel
     OR customer.workspace_id <> c.workspace_id
     OR COALESCE(customer.connection_id, customer_r.connection_id) IS DISTINCT FROM r.connection_id
     OR (c.connection_id IS NOT NULL AND c.connection_id <> r.connection_id);

  IF invalid_customers > 0 OR invalid_conversations > 0 THEN
    RAISE EXCEPTION 'migration 010 reconciliation rejected: invalid_customer_mappings=%, invalid_conversation_mappings=%',
      invalid_customers, invalid_conversations;
  END IF;
END $$;

UPDATE public.customers c
SET connection_id = r.connection_id,
    provider_user_id = r.provider_user_id
FROM ydeck_migration.customer_identity_reconciliation r
WHERE c.id = r.customer_id
  AND (c.connection_id IS NULL OR c.provider_user_id IS NULL);

UPDATE public.conversations c
SET connection_id = r.connection_id
FROM ydeck_migration.conversation_connection_reconciliation r
WHERE c.id = r.conversation_id
  AND c.connection_id IS NULL;

DO $$
DECLARE
  unresolved_customers BIGINT;
  unresolved_conversations BIGINT;
  invalid_customer_connections BIGINT;
  invalid_conversation_connections BIGINT;
  duplicate_customer_identities BIGINT;
  duplicate_open_conversations BIGINT;
BEGIN
  SELECT COUNT(*) INTO unresolved_customers
    FROM public.customers WHERE connection_id IS NULL OR provider_user_id IS NULL;
  SELECT COUNT(*) INTO unresolved_conversations
    FROM public.conversations WHERE connection_id IS NULL;
  SELECT COUNT(*) INTO invalid_customer_connections
    FROM public.customers c LEFT JOIN public.channel_connections cc
      ON cc.id = c.connection_id AND cc.workspace_id = c.workspace_id
    WHERE cc.id IS NULL;
  SELECT COUNT(*) INTO invalid_conversation_connections
    FROM public.conversations c
    JOIN public.customers customer ON customer.id = c.customer_id
    LEFT JOIN public.channel_connections cc
      ON cc.id = c.connection_id AND cc.workspace_id = c.workspace_id AND cc.channel = c.channel
    WHERE cc.id IS NULL OR customer.workspace_id <> c.workspace_id
       OR customer.connection_id IS DISTINCT FROM c.connection_id;
  SELECT COUNT(*) INTO duplicate_customer_identities FROM (
    SELECT 1 FROM public.customers GROUP BY connection_id, provider_user_id HAVING COUNT(*) > 1
  ) duplicates;
  SELECT COUNT(*) INTO duplicate_open_conversations FROM (
    SELECT 1 FROM public.conversations
    WHERE status NOT IN ('resolved','closed','spam')
    GROUP BY connection_id, customer_id HAVING COUNT(*) > 1
  ) duplicates;

  IF unresolved_customers > 0 OR unresolved_conversations > 0
     OR invalid_customer_connections > 0 OR invalid_conversation_connections > 0
     OR duplicate_customer_identities > 0 OR duplicate_open_conversations > 0 THEN
    RAISE EXCEPTION 'migration 010 identity gate failed: unresolved_customers=%, unresolved_conversations=%, invalid_customer_connections=%, invalid_conversation_connections=%, duplicate_customer_identities=%, duplicate_open_conversations=%',
      unresolved_customers, unresolved_conversations, invalid_customer_connections,
      invalid_conversation_connections, duplicate_customer_identities, duplicate_open_conversations;
  END IF;
END $$;

-- Make the customer/connection relationship durable after the one-time gate.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.customers'::regclass
      AND conname = 'customers_id_workspace_connection_unique'
  ) THEN
    ALTER TABLE public.customers ADD CONSTRAINT customers_id_workspace_connection_unique
      UNIQUE (id, workspace_id, connection_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.conversations'::regclass
      AND conname = 'conversations_customer_connection_fk'
  ) THEN
    ALTER TABLE public.conversations ADD CONSTRAINT conversations_customer_connection_fk
      FOREIGN KEY (customer_id, workspace_id, connection_id)
      REFERENCES public.customers(id, workspace_id, connection_id)
      ON DELETE CASCADE NOT VALID;
  END IF;
END $$;

-- Complete every NOT VALID constraint introduced by 007 once reconciliation is ready.
ALTER TABLE public.provider_events VALIDATE CONSTRAINT provider_events_completion_check;
ALTER TABLE public.customers VALIDATE CONSTRAINT customers_connection_tenant_fk;
ALTER TABLE public.customers VALIDATE CONSTRAINT customers_provider_identity_pair_check;
ALTER TABLE public.conversations VALIDATE CONSTRAINT conversations_connection_tenant_fk;
ALTER TABLE public.conversations VALIDATE CONSTRAINT conversations_customer_connection_fk;
ALTER TABLE public.messages VALIDATE CONSTRAINT messages_conversation_tenant_fk;
ALTER TABLE public.messages VALIDATE CONSTRAINT messages_provider_event_tenant_fk;
ALTER TABLE public.messages VALIDATE CONSTRAINT messages_parent_tenant_fk;
ALTER TABLE public.provider_events VALIDATE CONSTRAINT provider_events_result_message_tenant_fk;
ALTER TABLE public.provider_events VALIDATE CONSTRAINT provider_events_result_conversation_tenant_fk;

-- Validated checks let PostgreSQL avoid a full table scan while SET NOT NULL holds
-- its stronger lock. Validation itself uses the less disruptive lock level.
ALTER TABLE public.customers ADD CONSTRAINT customers_connection_id_not_null
  CHECK (connection_id IS NOT NULL) NOT VALID;
ALTER TABLE public.customers ADD CONSTRAINT customers_provider_user_id_not_null
  CHECK (provider_user_id IS NOT NULL) NOT VALID;
ALTER TABLE public.conversations ADD CONSTRAINT conversations_connection_id_not_null
  CHECK (connection_id IS NOT NULL) NOT VALID;
ALTER TABLE public.customers VALIDATE CONSTRAINT customers_connection_id_not_null;
ALTER TABLE public.customers VALIDATE CONSTRAINT customers_provider_user_id_not_null;
ALTER TABLE public.conversations VALIDATE CONSTRAINT conversations_connection_id_not_null;

ALTER TABLE public.customers ALTER COLUMN connection_id SET NOT NULL;
ALTER TABLE public.customers ALTER COLUMN provider_user_id SET NOT NULL;
ALTER TABLE public.conversations ALTER COLUMN connection_id SET NOT NULL;

ALTER TABLE public.customers DROP CONSTRAINT customers_connection_id_not_null;
ALTER TABLE public.customers DROP CONSTRAINT customers_provider_user_id_not_null;
ALTER TABLE public.conversations DROP CONSTRAINT conversations_connection_id_not_null;

COMMIT;
