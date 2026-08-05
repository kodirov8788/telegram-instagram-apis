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
    last_error TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT provider_events_status_check CHECK (status IN ('received', 'queued', 'processing', 'processed', 'retryable_failed', 'permanent_failed')),
    CONSTRAINT provider_events_connection_tenant_fk FOREIGN KEY (connection_id, workspace_id, provider) REFERENCES channel_connections(id, workspace_id, channel) ON DELETE CASCADE,
    CONSTRAINT provider_events_connection_event_unique UNIQUE (connection_id, provider_event_id)
);


-- 5. Customers
CREATE TABLE IF NOT EXISTS customers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
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
    last_contact_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 6. Conversations
DO $$ BEGIN CREATE TYPE control_mode AS ENUM ('auto', 'approval', 'suggestion', 'human'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE conversation_status AS ENUM ('new', 'ai_handling', 'waiting_for_customer', 'human_attention_required', 'human_handling', 'qualified_lead', 'resolved', 'closed', 'spam'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS conversations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
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
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 7. Messages
DO $$ BEGIN CREATE TYPE sender_type AS ENUM ('customer', 'ai', 'human_operator', 'system'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender sender_type NOT NULL,
    sender_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    content TEXT NOT NULL,
    message_type VARCHAR(50) DEFAULT 'text', -- text, image, document, voice, location, contact
    attachment_url TEXT,
    delivery_status VARCHAR(20) DEFAULT 'sent', -- pending, sent, delivered, failed
    ai_confidence FLOAT,
    knowledge_sources_used JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

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

-- Policy target roles must exist before CREATE POLICY references them.
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ydeck_tenant_runtime_v2') THEN CREATE ROLE ydeck_tenant_runtime_v2 NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION; END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='workspaces' AND policyname='workspace_tenant_policy') THEN CREATE POLICY workspace_tenant_policy ON workspaces USING (current_user_is_workspace_member(id)) WITH CHECK (current_user_is_workspace_member(id)); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='workspace_members' AND policyname='member_tenant_policy') THEN CREATE POLICY member_tenant_policy ON workspace_members USING (current_user_is_workspace_member(workspace_id)) WITH CHECK (current_user_is_workspace_member(workspace_id)); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='workspace_invitations' AND policyname='invitation_tenant_policy') THEN CREATE POLICY invitation_tenant_policy ON workspace_invitations USING (current_user_is_workspace_member(workspace_id)) WITH CHECK (current_user_is_workspace_member(workspace_id)); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='channel_connections' AND policyname='channel_tenant_policy') THEN CREATE POLICY channel_tenant_policy ON channel_connections USING (current_user_is_workspace_member(workspace_id)) WITH CHECK (current_user_is_workspace_member(workspace_id)); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='provider_events' AND policyname='provider_event_tenant_policy') THEN CREATE POLICY provider_event_tenant_policy ON provider_events USING (current_user_is_workspace_member(workspace_id)) WITH CHECK (current_user_is_workspace_member(workspace_id)); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='provider_events' AND policyname='provider_event_webhook_policy') THEN CREATE POLICY provider_event_webhook_policy ON provider_events TO ydeck_tenant_runtime_v2 USING (provider::TEXT = NULLIF(current_setting('app.webhook_provider', true), '') AND connection_id IN (SELECT id FROM public.channel_connections WHERE is_active IS TRUE AND webhook_identifier = NULLIF(current_setting('app.webhook_identifier', true), '')::UUID AND channel::TEXT = NULLIF(current_setting('app.webhook_provider', true), ''))) WITH CHECK (provider::TEXT = NULLIF(current_setting('app.webhook_provider', true), '') AND connection_id IN (SELECT id FROM public.channel_connections WHERE is_active IS TRUE AND webhook_identifier = NULLIF(current_setting('app.webhook_identifier', true), '')::UUID AND channel::TEXT = NULLIF(current_setting('app.webhook_provider', true), ''))); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='customers' AND policyname='customer_tenant_policy') THEN CREATE POLICY customer_tenant_policy ON customers USING (current_user_is_workspace_member(workspace_id)) WITH CHECK (current_user_is_workspace_member(workspace_id)); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='conversations' AND policyname='conversation_tenant_policy') THEN CREATE POLICY conversation_tenant_policy ON conversations USING (current_user_is_workspace_member(workspace_id)) WITH CHECK (current_user_is_workspace_member(workspace_id)); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='messages' AND policyname='message_tenant_policy') THEN CREATE POLICY message_tenant_policy ON messages USING (EXISTS(SELECT 1 FROM public.conversations c WHERE c.id=conversation_id AND public.current_user_is_workspace_member(c.workspace_id))) WITH CHECK (EXISTS(SELECT 1 FROM public.conversations c WHERE c.id=conversation_id AND public.current_user_is_workspace_member(c.workspace_id))); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='leads' AND policyname='lead_tenant_policy') THEN CREATE POLICY lead_tenant_policy ON leads USING (current_user_is_workspace_member(workspace_id)) WITH CHECK (current_user_is_workspace_member(workspace_id)); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='knowledge_items' AND policyname='knowledge_tenant_policy') THEN CREATE POLICY knowledge_tenant_policy ON knowledge_items USING (current_user_is_workspace_member(workspace_id)) WITH CHECK (current_user_is_workspace_member(workspace_id)); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='follow_up_rules' AND policyname='follow_up_tenant_policy') THEN CREATE POLICY follow_up_tenant_policy ON follow_up_rules USING (current_user_is_workspace_member(workspace_id)) WITH CHECK (current_user_is_workspace_member(workspace_id)); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='audit_logs' AND policyname='audit_tenant_policy') THEN CREATE POLICY audit_tenant_policy ON audit_logs USING (current_user_is_workspace_member(workspace_id)) WITH CHECK (current_user_is_workspace_member(workspace_id)); END IF; END $$;


-- Fresh-install equivalents of migration 002 integrity and runtime-role controls.
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='customers_id_workspace_unique' AND conrelid='public.customers'::regclass) THEN ALTER TABLE customers ADD CONSTRAINT customers_id_workspace_unique UNIQUE(id,workspace_id); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='conversations_id_workspace_unique' AND conrelid='public.conversations'::regclass) THEN ALTER TABLE conversations ADD CONSTRAINT conversations_id_workspace_unique UNIQUE(id,workspace_id); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='conversations_customer_tenant_fk' AND conrelid='public.conversations'::regclass) THEN ALTER TABLE conversations ADD CONSTRAINT conversations_customer_tenant_fk FOREIGN KEY(customer_id,workspace_id) REFERENCES customers(id,workspace_id); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='leads_customer_tenant_fk' AND conrelid='public.leads'::regclass) THEN ALTER TABLE leads ADD CONSTRAINT leads_customer_tenant_fk FOREIGN KEY(customer_id,workspace_id) REFERENCES customers(id,workspace_id); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='leads_conversation_tenant_fk' AND conrelid='public.leads'::regclass) THEN ALTER TABLE leads ADD CONSTRAINT leads_conversation_tenant_fk FOREIGN KEY(conversation_id,workspace_id) REFERENCES conversations(id,workspace_id); END IF;
END $$;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ydeck_tenant_runtime_v2' AND (rolcanlogin OR rolinherit OR rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication)) THEN RAISE EXCEPTION 'unsafe attributes on ydeck_tenant_runtime_v2'; END IF; END $$;
GRANT ydeck_tenant_runtime_v2 TO CURRENT_USER;
REVOKE ALL ON FUNCTION current_user_is_workspace_member(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION current_user_is_workspace_member(UUID) TO ydeck_tenant_runtime_v2;
GRANT SELECT,INSERT,UPDATE,DELETE ON workspaces,workspace_members,workspace_invitations,channel_connections,customers,conversations,messages,leads,knowledge_items,follow_up_rules,audit_logs TO ydeck_tenant_runtime_v2;
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
 INSERT INTO public.workspace_members(workspace_id,user_id,role) VALUES(invite_workspace,actor,invite_role) ON CONFLICT ON CONSTRAINT workspace_members_pkey DO NOTHING RETURNING user_id INTO inserted;
 IF inserted IS NULL THEN RETURN; END IF;
 UPDATE public.workspace_invitations SET accepted_at=NOW() WHERE id=invite_id;
 workspace_id:=invite_workspace; role:=invite_role; RETURN NEXT;
END $fn$;
REVOKE ALL ON FUNCTION bootstrap_workspace(TEXT,TEXT,TEXT,TEXT,JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION accept_workspace_invitation(TEXT) FROM PUBLIC;
-- Bootstrap SECURITY DEFINER functions and the membership predicate must owner-bypass
-- these three tables; the non-owner runtime role remains subject to their enabled RLS.
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['channel_connections','provider_events','customers','conversations','messages','leads','knowledge_items','follow_up_rules','audit_logs'] LOOP EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t); END LOOP; END $$;
