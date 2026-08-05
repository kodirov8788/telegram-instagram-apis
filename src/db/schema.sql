-- ====================================================================
-- TELEGRAM & INSTAGRAM AI CUSTOMER COMMUNICATION AGENT
-- Database Schema Definition (PostgreSQL + pgvector)
-- ====================================================================

-- 1. Enable Vector Extension for Knowledge RAG
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 2. Workspaces (Multi-Tenancy)
CREATE TABLE IF NOT EXISTS workspaces (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    industry VARCHAR(100),
    time_zone VARCHAR(100) DEFAULT 'UTC',
    default_language VARCHAR(10) DEFAULT 'uz',
    working_hours JSONB DEFAULT '{"start": "09:00", "end": "18:00", "days": [1,2,3,4,5]}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Users & Workspace Memberships (RBAC)
DO $$ BEGIN CREATE TYPE user_role AS ENUM ('owner', 'admin', 'sales_manager', 'sales_representative', 'support_operator', 'read_only_analyst'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    full_name VARCHAR(255) NOT NULL,
    password_hash VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workspace_members (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role user_role NOT NULL DEFAULT 'support_operator',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(workspace_id, user_id)
);

CREATE TABLE IF NOT EXISTS user_sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash CHAR(64) UNIQUE NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    revoked_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workspace_invitations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    email VARCHAR(255) NOT NULL,
    role user_role NOT NULL CHECK (role <> 'owner'),
    token_hash CHAR(64) UNIQUE NOT NULL,
    invited_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    accepted_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- 4. Channel Connections (Telegram & Instagram)
DO $$ BEGIN CREATE TYPE channel_type AS ENUM ('telegram', 'instagram'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS channel_connections (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    webhook_identifier UUID NOT NULL DEFAULT uuid_generate_v4(),
    channel channel_type NOT NULL,
    account_identifier VARCHAR(255) NOT NULL, -- Bot username or IG Business Account ID
    credentials JSONB NOT NULL, -- Encrypted tokens/keys
    is_active BOOLEAN DEFAULT TRUE,
    last_synced_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(id, workspace_id),
    UNIQUE(id, workspace_id, channel)
);

-- 4.1. Provider Events
CREATE TABLE IF NOT EXISTS provider_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    connection_id UUID NOT NULL,
    provider channel_type NOT NULL,
    provider_event_id VARCHAR(255) NOT NULL,
    payload JSONB NOT NULL,
    payload_hash CHAR(64) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'received',
    attempts INTEGER NOT NULL DEFAULT 0,
    processed_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    result_message_id UUID,
    result_conversation_id UUID,
    last_error TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT provider_events_status_check CHECK (status IN ('received', 'queued', 'processing', 'processed', 'retryable_failed', 'permanent_failed')),
    CONSTRAINT provider_events_completion_check CHECK (status <> 'processed' OR completed_at IS NOT NULL),
    CONSTRAINT provider_events_connection_tenant_fk FOREIGN KEY (connection_id, workspace_id, provider) REFERENCES channel_connections(id, workspace_id, channel) ON DELETE CASCADE,
    CONSTRAINT provider_events_connection_event_unique UNIQUE (connection_id, provider_event_id)
);


-- 5. Customers
CREATE TABLE IF NOT EXISTS customers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    connection_id UUID NOT NULL,
    provider_user_id TEXT NOT NULL,
    full_name VARCHAR(255),
    telegram_username VARCHAR(255),
    telegram_id VARCHAR(255),
    instagram_username VARCHAR(255),
    instagram_id VARCHAR(255),
    phone_number VARCHAR(50),
    email VARCHAR(255),
    preferred_language VARCHAR(10) DEFAULT 'uz',
    tags TEXT[] DEFAULT '{}',
    consent_status BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_contact_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT customers_connection_tenant_fk FOREIGN KEY(connection_id,workspace_id) REFERENCES channel_connections(id,workspace_id) ON DELETE RESTRICT,
    CONSTRAINT customers_provider_identity_pair_check CHECK ((connection_id IS NULL) = (provider_user_id IS NULL)),
    CONSTRAINT customers_connection_provider_user_unique UNIQUE(connection_id,provider_user_id),
    CONSTRAINT customers_id_workspace_connection_unique UNIQUE(id,workspace_id,connection_id)
);

-- 6. Conversations
DO $$ BEGIN CREATE TYPE control_mode AS ENUM ('auto', 'approval', 'suggestion', 'human'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE conversation_status AS ENUM ('new', 'ai_handling', 'waiting_for_customer', 'human_attention_required', 'human_handling', 'qualified_lead', 'resolved', 'closed', 'spam'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS conversations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    connection_id UUID NOT NULL,
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    channel channel_type NOT NULL,
    status conversation_status DEFAULT 'new',
    mode control_mode DEFAULT 'auto',
    assigned_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    detected_language VARCHAR(10) DEFAULT 'uz',
    detected_intent VARCHAR(100),
    sentiment VARCHAR(20) DEFAULT 'neutral', -- positive, neutral, negative, angry
    lead_score INT DEFAULT 0,
    unread_count INT DEFAULT 0,
    summary TEXT,
    last_message_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT conversations_connection_tenant_fk FOREIGN KEY(connection_id,workspace_id,channel) REFERENCES channel_connections(id,workspace_id,channel) ON DELETE RESTRICT,
    CONSTRAINT conversations_customer_connection_fk FOREIGN KEY(customer_id,workspace_id,connection_id) REFERENCES customers(id,workspace_id,connection_id) ON DELETE CASCADE
);

-- 7. Messages
DO $$ BEGIN CREATE TYPE sender_type AS ENUM ('customer', 'ai', 'human_operator', 'system'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    provider_event_id UUID,
    parent_message_id UUID,
    provider_message_id TEXT,
    sender sender_type NOT NULL,
    sender_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    content TEXT NOT NULL,
    message_type VARCHAR(50) DEFAULT 'text', -- text, image, document, voice, location, contact
    attachment_url TEXT,
    delivery_status VARCHAR(20) DEFAULT 'sent', -- pending, sent, delivered, failed, unknown
    ai_confidence FLOAT,
    knowledge_sources_used JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT messages_delivery_status_check CHECK(delivery_status IN ('pending','sent','delivered','failed','unknown'))
);

CREATE TABLE IF NOT EXISTS outbound_jobs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    connection_id UUID NOT NULL,
    conversation_id UUID NOT NULL,
    message_id UUID NOT NULL,
    idempotency_key TEXT NOT NULL,
    provider channel_type NOT NULL,
    recipient_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','queued','processing','retryable_failed','sent','permanent_failed','cancelled','ambiguous')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    locked_at TIMESTAMPTZ,
    locked_by TEXT,
    dispatched_at TIMESTAMPTZ,
    provider_message_id TEXT,
    last_error TEXT,
    sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT outbound_jobs_connection_tenant_fk FOREIGN KEY(connection_id,workspace_id) REFERENCES channel_connections(id,workspace_id) ON DELETE RESTRICT,
    CONSTRAINT outbound_jobs_workspace_idempotency_unique UNIQUE(workspace_id,idempotency_key),
    CONSTRAINT outbound_jobs_message_unique UNIQUE(message_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS outbound_jobs_provider_ack_unique
  ON outbound_jobs(connection_id,provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_outbound_jobs_ambiguous
  ON outbound_jobs(dispatched_at,created_at) WHERE status='ambiguous';

-- 8. Leads
DO $$ BEGIN CREATE TYPE lead_status AS ENUM ('unqualified', 'new_lead', 'interested', 'qualified', 'high_priority', 'not_interested', 'customer', 'lost'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS leads (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
    requested_product_or_service VARCHAR(255),
    budget VARCHAR(100),
    timeline VARCHAR(100),
    status lead_status DEFAULT 'new_lead',
    score INT DEFAULT 0,
    assigned_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    next_action TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 9. Knowledge Base (RAG Vectors)
CREATE TABLE IF NOT EXISTS knowledge_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    content TEXT NOT NULL,
    category VARCHAR(100) DEFAULT 'general', -- faq, catalog, policy, script
    language VARCHAR(10) DEFAULT 'uz',
    embedding vector(1536), -- Vector embeddings for similarity search
    is_approved BOOLEAN DEFAULT TRUE,
    valid_from DATE,
    valid_until DATE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 10. Follow-Up Rules Automation
CREATE TABLE IF NOT EXISTS follow_up_rules (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    trigger_event VARCHAR(100) NOT NULL, -- e.g. lead_inactive_24h, appointment_reminder
    delay_hours INT NOT NULL DEFAULT 24,
    message_template TEXT NOT NULL,
    max_attempts INT DEFAULT 1,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 11. System Audit Logs
CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
    actor_type VARCHAR(50) NOT NULL, -- user, ai_agent, system
    actor_id UUID,
    action VARCHAR(255) NOT NULL,
    entity_type VARCHAR(100) NOT NULL,
    entity_id UUID,
    previous_value JSONB,
    new_value JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Performance Indexes
CREATE INDEX IF NOT EXISTS idx_conversations_workspace_status ON conversations(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_leads_workspace_status ON leads(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_knowledge_items_workspace ON knowledge_items(workspace_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_workspace_invitations_workspace ON workspace_invitations(workspace_id);
CREATE UNIQUE INDEX IF NOT EXISTS workspace_invitations_one_live_email ON workspace_invitations(workspace_id, lower(email)) WHERE accepted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS channel_connections_webhook_identifier_unique ON channel_connections(webhook_identifier);
CREATE INDEX IF NOT EXISTS idx_provider_events_status ON provider_events(status);
CREATE INDEX IF NOT EXISTS idx_provider_events_workspace_id ON provider_events(workspace_id);
CREATE INDEX IF NOT EXISTS idx_provider_events_recovery ON provider_events(status,updated_at) WHERE status IN ('received','queued','processing','retryable_failed');
CREATE UNIQUE INDEX IF NOT EXISTS conversations_one_open_per_connection_customer ON conversations(connection_id,customer_id) WHERE status NOT IN ('resolved','closed','spam');
CREATE INDEX IF NOT EXISTS idx_messages_provider_message ON messages(workspace_id,provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS messages_provider_event_unique ON messages(provider_event_id) WHERE provider_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(parent_message_id) WHERE parent_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_outbound_jobs_claim ON outbound_jobs(next_attempt_at,created_at) WHERE status IN ('pending','queued','retryable_failed');
CREATE INDEX IF NOT EXISTS idx_outbound_jobs_conversation ON outbound_jobs(conversation_id,created_at DESC);

-- Supabase/PostgREST defense in depth. Direct clients cannot select another tenant.
CREATE OR REPLACE FUNCTION current_user_is_workspace_member(target UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.workspace_members WHERE workspace_id = target
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
$$;

ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE follow_up_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbound_jobs ENABLE ROW LEVEL SECURITY;

-- Policy target roles must exist before CREATE POLICY references them.
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ydeck_tenant_runtime_v2') THEN CREATE ROLE ydeck_tenant_runtime_v2 NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION; END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='workspaces' AND policyname='workspace_tenant_policy') THEN CREATE POLICY workspace_tenant_policy ON workspaces USING (current_user_is_workspace_member(id)) WITH CHECK (current_user_is_workspace_member(id)); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='workspace_members' AND policyname='member_tenant_policy') THEN CREATE POLICY member_tenant_policy ON workspace_members USING (current_user_is_workspace_member(workspace_id)) WITH CHECK (current_user_is_workspace_member(workspace_id)); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='workspace_invitations' AND policyname='invitation_tenant_policy') THEN CREATE POLICY invitation_tenant_policy ON workspace_invitations USING (current_user_is_workspace_member(workspace_id)) WITH CHECK (current_user_is_workspace_member(workspace_id)); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='channel_connections' AND policyname='channel_tenant_policy') THEN CREATE POLICY channel_tenant_policy ON channel_connections USING (current_user_is_workspace_member(workspace_id)) WITH CHECK (current_user_is_workspace_member(workspace_id)); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='provider_events' AND policyname='provider_event_tenant_policy') THEN CREATE POLICY provider_event_tenant_policy ON provider_events USING (current_user_is_workspace_member(workspace_id)) WITH CHECK (current_user_is_workspace_member(workspace_id)); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='provider_events' AND policyname='provider_event_webhook_policy') THEN CREATE POLICY provider_event_webhook_policy ON provider_events FOR INSERT TO ydeck_tenant_runtime_v2 WITH CHECK (provider::TEXT = NULLIF(current_setting('app.webhook_provider', true), '') AND connection_id IN (SELECT id FROM public.channel_connections WHERE is_active IS TRUE AND webhook_identifier = NULLIF(current_setting('app.webhook_identifier', true), '')::UUID AND channel::TEXT = NULLIF(current_setting('app.webhook_provider', true), ''))); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='customers' AND policyname='customer_tenant_policy') THEN CREATE POLICY customer_tenant_policy ON customers USING (current_user_is_workspace_member(workspace_id)) WITH CHECK (current_user_is_workspace_member(workspace_id)); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='conversations' AND policyname='conversation_tenant_policy') THEN CREATE POLICY conversation_tenant_policy ON conversations USING (current_user_is_workspace_member(workspace_id)) WITH CHECK (current_user_is_workspace_member(workspace_id)); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='messages' AND policyname='message_tenant_policy') THEN CREATE POLICY message_tenant_policy ON messages USING (public.current_user_is_workspace_member(workspace_id)) WITH CHECK (public.current_user_is_workspace_member(workspace_id)); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='leads' AND policyname='lead_tenant_policy') THEN CREATE POLICY lead_tenant_policy ON leads USING (current_user_is_workspace_member(workspace_id)) WITH CHECK (current_user_is_workspace_member(workspace_id)); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='knowledge_items' AND policyname='knowledge_tenant_policy') THEN CREATE POLICY knowledge_tenant_policy ON knowledge_items USING (current_user_is_workspace_member(workspace_id)) WITH CHECK (current_user_is_workspace_member(workspace_id)); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='follow_up_rules' AND policyname='follow_up_tenant_policy') THEN CREATE POLICY follow_up_tenant_policy ON follow_up_rules USING (current_user_is_workspace_member(workspace_id)) WITH CHECK (current_user_is_workspace_member(workspace_id)); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='audit_logs' AND policyname='audit_tenant_policy') THEN CREATE POLICY audit_tenant_policy ON audit_logs USING (current_user_is_workspace_member(workspace_id)) WITH CHECK (current_user_is_workspace_member(workspace_id)); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='outbound_jobs' AND policyname='outbound_job_tenant_policy') THEN CREATE POLICY outbound_job_tenant_policy ON outbound_jobs USING (current_user_is_workspace_member(workspace_id)) WITH CHECK (current_user_is_workspace_member(workspace_id)); END IF; END $$;


-- Fresh-install equivalents of migration 002 integrity and runtime-role controls.
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='customers_id_workspace_unique' AND conrelid='public.customers'::regclass) THEN ALTER TABLE customers ADD CONSTRAINT customers_id_workspace_unique UNIQUE(id,workspace_id); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='conversations_id_workspace_unique' AND conrelid='public.conversations'::regclass) THEN ALTER TABLE conversations ADD CONSTRAINT conversations_id_workspace_unique UNIQUE(id,workspace_id); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='messages_id_workspace_unique' AND conrelid='public.messages'::regclass) THEN ALTER TABLE messages ADD CONSTRAINT messages_id_workspace_unique UNIQUE(id,workspace_id); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='provider_events_id_workspace_unique' AND conrelid='public.provider_events'::regclass) THEN ALTER TABLE provider_events ADD CONSTRAINT provider_events_id_workspace_unique UNIQUE(id,workspace_id); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='conversations_customer_tenant_fk' AND conrelid='public.conversations'::regclass) THEN ALTER TABLE conversations ADD CONSTRAINT conversations_customer_tenant_fk FOREIGN KEY(customer_id,workspace_id) REFERENCES customers(id,workspace_id); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='leads_customer_tenant_fk' AND conrelid='public.leads'::regclass) THEN ALTER TABLE leads ADD CONSTRAINT leads_customer_tenant_fk FOREIGN KEY(customer_id,workspace_id) REFERENCES customers(id,workspace_id); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='leads_conversation_tenant_fk' AND conrelid='public.leads'::regclass) THEN ALTER TABLE leads ADD CONSTRAINT leads_conversation_tenant_fk FOREIGN KEY(conversation_id,workspace_id) REFERENCES conversations(id,workspace_id); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='messages_conversation_tenant_fk' AND conrelid='public.messages'::regclass) THEN ALTER TABLE messages ADD CONSTRAINT messages_conversation_tenant_fk FOREIGN KEY(conversation_id,workspace_id) REFERENCES conversations(id,workspace_id) ON DELETE CASCADE; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='messages_provider_event_tenant_fk' AND conrelid='public.messages'::regclass) THEN ALTER TABLE messages ADD CONSTRAINT messages_provider_event_tenant_fk FOREIGN KEY(provider_event_id,workspace_id) REFERENCES provider_events(id,workspace_id) ON DELETE RESTRICT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='messages_parent_tenant_fk' AND conrelid='public.messages'::regclass) THEN ALTER TABLE messages ADD CONSTRAINT messages_parent_tenant_fk FOREIGN KEY(parent_message_id,workspace_id) REFERENCES messages(id,workspace_id) ON DELETE RESTRICT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='provider_events_result_message_tenant_fk' AND conrelid='public.provider_events'::regclass) THEN ALTER TABLE provider_events ADD CONSTRAINT provider_events_result_message_tenant_fk FOREIGN KEY(result_message_id,workspace_id) REFERENCES messages(id,workspace_id) ON DELETE RESTRICT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='provider_events_result_conversation_tenant_fk' AND conrelid='public.provider_events'::regclass) THEN ALTER TABLE provider_events ADD CONSTRAINT provider_events_result_conversation_tenant_fk FOREIGN KEY(result_conversation_id,workspace_id) REFERENCES conversations(id,workspace_id) ON DELETE RESTRICT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='outbound_jobs_conversation_tenant_fk' AND conrelid='public.outbound_jobs'::regclass) THEN ALTER TABLE outbound_jobs ADD CONSTRAINT outbound_jobs_conversation_tenant_fk FOREIGN KEY(conversation_id,workspace_id) REFERENCES conversations(id,workspace_id) ON DELETE CASCADE; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='outbound_jobs_message_tenant_fk' AND conrelid='public.outbound_jobs'::regclass) THEN ALTER TABLE outbound_jobs ADD CONSTRAINT outbound_jobs_message_tenant_fk FOREIGN KEY(message_id,workspace_id) REFERENCES messages(id,workspace_id) ON DELETE CASCADE; END IF;
END $$;

-- Dedicated queue-worker role. It receives queue consumption and only the data
-- privileges required to normalize inbound events and deliver outbound jobs.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ydeck_queue_worker_v1') THEN
    CREATE ROLE ydeck_queue_worker_v1 NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ydeck_queue_worker_v1' AND (rolcanlogin OR rolinherit OR rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication)) THEN
    RAISE EXCEPTION 'unsafe attributes on ydeck_queue_worker_v1';
  END IF;
END $$;
GRANT ydeck_queue_worker_v1 TO CURRENT_USER;
GRANT USAGE ON SCHEMA public TO ydeck_queue_worker_v1;
GRANT EXECUTE ON FUNCTION current_user_is_workspace_member(UUID) TO ydeck_queue_worker_v1;
GRANT SELECT,UPDATE ON provider_events TO ydeck_queue_worker_v1;
GRANT SELECT,INSERT,UPDATE ON customers,conversations,messages,outbound_jobs TO ydeck_queue_worker_v1;
GRANT SELECT ON channel_connections TO ydeck_queue_worker_v1;

DO $$ DECLARE item record; BEGIN
  FOR item IN SELECT * FROM (VALUES
    ('provider_events','provider_event_worker_policy'),('customers','customer_worker_policy'),
    ('conversations','conversation_worker_policy'),('messages','message_worker_policy'),
    ('outbound_jobs','outbound_job_worker_policy')) v(tablename,policyname)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename=item.tablename AND policyname=item.policyname) THEN
      EXECUTE format('CREATE POLICY %I ON %I TO ydeck_queue_worker_v1 USING (workspace_id=NULLIF(current_setting(''app.workspace_id'',true),'''')::uuid) WITH CHECK (workspace_id=NULLIF(current_setting(''app.workspace_id'',true),'''')::uuid)',item.policyname,item.tablename);
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='channel_connections' AND policyname='channel_worker_policy') THEN
    CREATE POLICY channel_worker_policy ON channel_connections TO ydeck_queue_worker_v1 USING (workspace_id=NULLIF(current_setting('app.workspace_id',true),'')::uuid);
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname='pgmq') THEN
    EXECUTE 'REVOKE EXECUTE ON FUNCTION ydeck_queue.read(text,integer,integer,jsonb) FROM ydeck_tenant_runtime_v2';
    EXECUTE 'REVOKE EXECUTE ON FUNCTION ydeck_queue.delete(text,bigint) FROM ydeck_tenant_runtime_v2';
    EXECUTE 'REVOKE EXECUTE ON FUNCTION ydeck_queue.archive(text,bigint) FROM ydeck_tenant_runtime_v2';
    EXECUTE 'GRANT USAGE ON SCHEMA ydeck_queue TO ydeck_queue_worker_v1';
    EXECUTE 'GRANT EXECUTE ON FUNCTION ydeck_queue.send(text,jsonb,integer) TO ydeck_queue_worker_v1';
    EXECUTE 'GRANT EXECUTE ON FUNCTION ydeck_queue.read(text,integer,integer,jsonb) TO ydeck_queue_worker_v1';
    EXECUTE 'GRANT EXECUTE ON FUNCTION ydeck_queue.delete(text,bigint) TO ydeck_queue_worker_v1';
    EXECUTE 'GRANT EXECUTE ON FUNCTION ydeck_queue.archive(text,bigint) TO ydeck_queue_worker_v1';
  END IF;
END $$;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ydeck_tenant_runtime_v2' AND (rolcanlogin OR rolinherit OR rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication)) THEN RAISE EXCEPTION 'unsafe attributes on ydeck_tenant_runtime_v2'; END IF; END $$;
GRANT ydeck_tenant_runtime_v2 TO CURRENT_USER;
REVOKE ALL ON FUNCTION current_user_is_workspace_member(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION current_user_is_workspace_member(UUID) TO ydeck_tenant_runtime_v2;
GRANT SELECT,INSERT,UPDATE,DELETE ON workspaces,workspace_members,workspace_invitations,channel_connections,customers,conversations,messages,leads,knowledge_items,follow_up_rules,audit_logs,outbound_jobs TO ydeck_tenant_runtime_v2;
GRANT SELECT,INSERT ON provider_events TO ydeck_tenant_runtime_v2;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='channel_connections' AND policyname='channel_webhook_resolution_policy') THEN CREATE POLICY channel_webhook_resolution_policy ON channel_connections FOR SELECT TO ydeck_tenant_runtime_v2 USING (is_active IS TRUE AND webhook_identifier = NULLIF(current_setting('app.webhook_identifier', true), '')::UUID AND channel::TEXT = NULLIF(current_setting('app.webhook_provider', true), '')); END IF; END $$;
CREATE OR REPLACE FUNCTION bootstrap_workspace(p_name TEXT, p_industry TEXT, p_time_zone TEXT, p_default_language TEXT, p_working_hours JSONB)
RETURNS SETOF public.workspaces LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE actor UUID; created public.workspaces%ROWTYPE;
BEGIN
 actor := NULLIF(current_setting('app.user_id',true),'')::UUID;
 IF actor IS NULL OR NOT EXISTS(SELECT 1 FROM public.users WHERE id=actor) THEN RAISE EXCEPTION 'authenticated identity required' USING ERRCODE='28000'; END IF;
 INSERT INTO public.workspaces(name,industry,time_zone,default_language,working_hours) VALUES(p_name,p_industry,p_time_zone,p_default_language,p_working_hours) RETURNING * INTO created;
 INSERT INTO public.workspace_members(workspace_id,user_id,role) VALUES(created.id,actor,'owner');
 RETURN NEXT created;
END $fn$;
CREATE OR REPLACE FUNCTION accept_workspace_invitation(p_token_hash TEXT)
RETURNS TABLE(workspace_id UUID, role user_role) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE actor UUID; invite_id UUID; invite_workspace UUID; invite_role user_role; inserted UUID;
BEGIN
 actor := NULLIF(current_setting('app.user_id',true),'')::UUID;
 IF actor IS NULL THEN RAISE EXCEPTION 'authenticated identity required' USING ERRCODE='28000'; END IF;
 SELECT i.id,i.workspace_id,i.role INTO invite_id,invite_workspace,invite_role FROM public.workspace_invitations i JOIN public.users u ON u.id=actor AND lower(u.email)=lower(i.email) WHERE i.token_hash=p_token_hash AND i.accepted_at IS NULL AND i.expires_at>NOW() FOR UPDATE OF i;
 IF NOT FOUND THEN RETURN; END IF;
 INSERT INTO public.workspace_members(workspace_id,user_id,role) VALUES(invite_workspace,actor,invite_role) ON CONFLICT(workspace_id,user_id) DO UPDATE SET role=EXCLUDED.role RETURNING user_id INTO inserted;
 UPDATE public.workspace_invitations SET accepted_at=NOW() WHERE id=invite_id;
 workspace_id:=invite_workspace; role:=invite_role; RETURN NEXT;
END $fn$;
REVOKE ALL ON FUNCTION bootstrap_workspace(TEXT,TEXT,TEXT,TEXT,JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION accept_workspace_invitation(TEXT) FROM PUBLIC;
-- Bootstrap SECURITY DEFINER functions and the membership predicate must owner-bypass
-- these three tables; the non-owner runtime role remains subject to their enabled RLS.
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['channel_connections','provider_events','customers','conversations','messages','leads','knowledge_items','follow_up_rules','audit_logs','outbound_jobs'] LOOP EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t); END LOOP; END $$;

-- Conditionally enable pgmq if available, to maintain stock test:db parity
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pgmq') THEN
    CREATE EXTENSION IF NOT EXISTS pgmq;

    -- Use dynamic SQL to prevent compilation errors when pgmq is not yet installed
    IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'pgmq' AND tablename = 'q_inbound_events') THEN
      EXECUTE 'SELECT pgmq.create(''inbound_events'')';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'pgmq' AND tablename = 'q_outbound_messages') THEN
      EXECUTE 'SELECT pgmq.create(''outbound_messages'')';
    END IF;

    -- Revoke from PUBLIC on pgmq
    EXECUTE 'REVOKE ALL ON SCHEMA pgmq FROM PUBLIC';
    EXECUTE 'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pgmq FROM PUBLIC';
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA pgmq FROM PUBLIC';

    -- Revoke from anon/authenticated on pgmq if they exist
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE 'REVOKE ALL ON SCHEMA pgmq FROM anon';
      EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA pgmq FROM anon';
      EXECUTE 'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pgmq FROM anon';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE 'REVOKE ALL ON SCHEMA pgmq FROM authenticated';
      EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA pgmq FROM authenticated';
      EXECUTE 'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pgmq FROM authenticated';
    END IF;

    -- Setup ydeck_queue
    EXECUTE 'CREATE SCHEMA IF NOT EXISTS ydeck_queue';

    EXECUTE 'CREATE OR REPLACE FUNCTION ydeck_queue.send(queue_name text, msg jsonb, delay integer DEFAULT 0)
    RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pgmq, pg_catalog, pg_temp AS $f$
    BEGIN
      IF queue_name NOT IN (''inbound_events'', ''outbound_messages'') THEN
        RAISE EXCEPTION ''Invalid queue name: %'', queue_name;
      END IF;
      IF delay IS NULL OR delay < 0 THEN
        RAISE EXCEPTION ''Delay must be an integer >= 0'';
      END IF;
      RETURN pgmq.send(queue_name, msg, delay);
    END; $f$';

    EXECUTE 'CREATE OR REPLACE FUNCTION ydeck_queue.read(queue_name text, visibility_timeout integer, qty integer, conditional jsonb DEFAULT ''{}''::jsonb)
    RETURNS TABLE (msg_id bigint, read_ct integer, enqueued_at timestamp with time zone, vt timestamp with time zone, message jsonb)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pgmq, pg_catalog, pg_temp AS $f$
    BEGIN
      IF queue_name NOT IN (''inbound_events'', ''outbound_messages'') THEN
        RAISE EXCEPTION ''Invalid queue name: %'', queue_name;
      END IF;
      IF visibility_timeout IS NULL OR visibility_timeout < 1 THEN
        RAISE EXCEPTION ''Visibility timeout must be an integer >= 1'';
      END IF;
      IF qty IS NULL OR qty < 1 OR qty > 5 THEN
        RAISE EXCEPTION ''Batch limit must be an integer between 1 and 5'';
      END IF;
      RETURN QUERY SELECT r.msg_id, r.read_ct, r.enqueued_at, r.vt, r.message FROM pgmq.read(queue_name, visibility_timeout, qty, conditional) AS r;
    END; $f$';

    EXECUTE 'CREATE OR REPLACE FUNCTION ydeck_queue.delete(queue_name text, msg_id bigint)
    RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pgmq, pg_catalog, pg_temp AS $f$
    BEGIN
      IF queue_name NOT IN (''inbound_events'', ''outbound_messages'') THEN
        RAISE EXCEPTION ''Invalid queue name: %'', queue_name;
      END IF;
      RETURN pgmq.delete(queue_name, msg_id);
    END; $f$';

    EXECUTE 'CREATE OR REPLACE FUNCTION ydeck_queue.archive(queue_name text, msg_id bigint)
    RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pgmq, pg_catalog, pg_temp AS $f$
    BEGIN
      IF queue_name NOT IN (''inbound_events'', ''outbound_messages'') THEN
        RAISE EXCEPTION ''Invalid queue name: %'', queue_name;
      END IF;
      RETURN pgmq.archive(queue_name, msg_id);
    END; $f$';

    -- Grant to CURRENT_USER (deploy role)
    EXECUTE 'GRANT USAGE ON SCHEMA pgmq TO CURRENT_USER';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE pgmq.q_inbound_events TO CURRENT_USER';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE pgmq.q_outbound_messages TO CURRENT_USER';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE pgmq.a_inbound_events TO CURRENT_USER';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE pgmq.a_outbound_messages TO CURRENT_USER';
    EXECUTE 'GRANT EXECUTE ON FUNCTION pgmq.send(text, jsonb, integer) TO CURRENT_USER';
    EXECUTE 'GRANT EXECUTE ON FUNCTION pgmq.read(text, integer, integer, jsonb) TO CURRENT_USER';
    EXECUTE 'GRANT EXECUTE ON FUNCTION pgmq.delete(text, bigint) TO CURRENT_USER';
    EXECUTE 'GRANT EXECUTE ON FUNCTION pgmq.archive(text, bigint) TO CURRENT_USER';

    -- Revoke ydeck_queue from PUBLIC/anon/authenticated
    EXECUTE 'REVOKE ALL ON SCHEMA ydeck_queue FROM PUBLIC';
    EXECUTE 'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ydeck_queue FROM PUBLIC';

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE 'REVOKE ALL ON SCHEMA ydeck_queue FROM anon';
      EXECUTE 'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ydeck_queue FROM anon';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE 'REVOKE ALL ON SCHEMA ydeck_queue FROM authenticated';
      EXECUTE 'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ydeck_queue FROM authenticated';
    END IF;

    -- Grant to ydeck_tenant_runtime_v2
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ydeck_tenant_runtime_v2') THEN
      EXECUTE 'GRANT USAGE ON SCHEMA ydeck_queue TO ydeck_tenant_runtime_v2';
      EXECUTE 'GRANT EXECUTE ON FUNCTION ydeck_queue.send(text, jsonb, integer) TO ydeck_tenant_runtime_v2';
      EXECUTE 'REVOKE EXECUTE ON FUNCTION ydeck_queue.read(text, integer, integer, jsonb) FROM ydeck_tenant_runtime_v2';
      EXECUTE 'REVOKE EXECUTE ON FUNCTION ydeck_queue.delete(text, bigint) FROM ydeck_tenant_runtime_v2';
      EXECUTE 'REVOKE EXECUTE ON FUNCTION ydeck_queue.archive(text, bigint) FROM ydeck_tenant_runtime_v2';
      EXECUTE 'GRANT USAGE ON SCHEMA ydeck_queue TO ydeck_queue_worker_v1';
      EXECUTE 'GRANT EXECUTE ON FUNCTION ydeck_queue.send(text, jsonb, integer) TO ydeck_queue_worker_v1';
      EXECUTE 'GRANT EXECUTE ON FUNCTION ydeck_queue.read(text, integer, integer, jsonb) TO ydeck_queue_worker_v1';
      EXECUTE 'GRANT EXECUTE ON FUNCTION ydeck_queue.delete(text, bigint) TO ydeck_queue_worker_v1';
      EXECUTE 'GRANT EXECUTE ON FUNCTION ydeck_queue.archive(text, bigint) TO ydeck_queue_worker_v1';
    END IF;
  ELSE
    RAISE NOTICE 'pgmq extension not available, skipping queue schema initialization';
  END IF;
END $$;
