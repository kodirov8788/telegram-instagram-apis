-- Migration 006: inbound identity preflight and safe, idempotent backfills.
BEGIN;

ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS connection_id UUID;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS provider_user_id TEXT;
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS connection_id UUID;
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS workspace_id UUID;
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS provider_event_id UUID;

UPDATE public.messages m
SET workspace_id = c.workspace_id
FROM public.conversations c
WHERE m.conversation_id = c.id AND m.workspace_id IS NULL;

WITH unique_active_connections AS (
  SELECT workspace_id, channel, MIN(id::text)::uuid AS connection_id
  FROM public.channel_connections WHERE is_active IS TRUE
  GROUP BY workspace_id, channel HAVING COUNT(*) = 1
)
UPDATE public.conversations c
SET connection_id = u.connection_id
FROM unique_active_connections u
WHERE c.workspace_id = u.workspace_id AND c.channel = u.channel
  AND c.connection_id IS NULL;

WITH customer_channels AS (
  SELECT id, workspace_id,
    CASE WHEN telegram_id IS NOT NULL AND instagram_id IS NULL THEN 'telegram'::public.channel_type
         WHEN instagram_id IS NOT NULL AND telegram_id IS NULL THEN 'instagram'::public.channel_type END AS legacy_channel,
    CASE WHEN telegram_id IS NOT NULL AND instagram_id IS NULL THEN telegram_id
         WHEN instagram_id IS NOT NULL AND telegram_id IS NULL THEN instagram_id END AS legacy_provider_user_id
  FROM public.customers
  WHERE (telegram_id IS NOT NULL AND instagram_id IS NULL)
     OR (instagram_id IS NOT NULL AND telegram_id IS NULL)
), unique_active_connections AS (
  SELECT workspace_id, channel, MIN(id::text)::uuid AS connection_id
  FROM public.channel_connections WHERE is_active IS TRUE
  GROUP BY workspace_id, channel HAVING COUNT(*) = 1
)
UPDATE public.customers c
SET connection_id = COALESCE(c.connection_id, u.connection_id),
    provider_user_id = COALESCE(c.provider_user_id, cc.legacy_provider_user_id)
FROM customer_channels cc
JOIN unique_active_connections u ON u.workspace_id = cc.workspace_id AND u.channel = cc.legacy_channel
WHERE c.id = cc.id
  AND (c.connection_id IS NULL OR c.connection_id = u.connection_id)
  AND (c.provider_user_id IS NULL OR c.provider_user_id = cc.legacy_provider_user_id)
  AND (c.connection_id IS NULL OR c.provider_user_id IS NULL);

-- Aggregate-only diagnostics deliberately avoid tenant, customer, and provider identifiers.
DO $$
DECLARE messages_unresolved bigint; conversations_unresolved bigint; customers_unresolved bigint;
BEGIN
  SELECT COUNT(*) INTO messages_unresolved FROM public.messages WHERE workspace_id IS NULL;
  SELECT COUNT(*) INTO conversations_unresolved FROM public.conversations WHERE connection_id IS NULL;
  SELECT COUNT(*) INTO customers_unresolved FROM public.customers WHERE connection_id IS NULL OR provider_user_id IS NULL;
  RAISE NOTICE 'migration 006 unresolved: messages=%, conversations=%, customers=%',
    messages_unresolved, conversations_unresolved, customers_unresolved;
END $$;

COMMIT;
