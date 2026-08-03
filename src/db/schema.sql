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
    channel channel_type NOT NULL,
    account_identifier VARCHAR(255) NOT NULL, -- Bot username or IG Business Account ID
    credentials JSONB NOT NULL, -- Encrypted tokens/keys
    is_active BOOLEAN DEFAULT TRUE,
    last_synced_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
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
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE follow_up_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='workspaces' AND policyname='workspace_tenant_policy') THEN CREATE POLICY workspace_tenant_policy ON workspaces USING (current_user_is_workspace_member(id)) WITH CHECK (current_user_is_workspace_member(id)); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='workspace_members' AND policyname='member_tenant_policy') THEN CREATE POLICY member_tenant_policy ON workspace_members USING (current_user_is_workspace_member(workspace_id)) WITH CHECK (current_user_is_workspace_member(workspace_id)); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='workspace_invitations' AND policyname='invitation_tenant_policy') THEN CREATE POLICY invitation_tenant_policy ON workspace_invitations USING (current_user_is_workspace_member(workspace_id)) WITH CHECK (current_user_is_workspace_member(workspace_id)); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='channel_connections' AND policyname='channel_tenant_policy') THEN CREATE POLICY channel_tenant_policy ON channel_connections USING (current_user_is_workspace_member(workspace_id)) WITH CHECK (current_user_is_workspace_member(workspace_id)); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='customers' AND policyname='customer_tenant_policy') THEN CREATE POLICY customer_tenant_policy ON customers USING (current_user_is_workspace_member(workspace_id)) WITH CHECK (current_user_is_workspace_member(workspace_id)); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='conversations' AND policyname='conversation_tenant_policy') THEN CREATE POLICY conversation_tenant_policy ON conversations USING (current_user_is_workspace_member(workspace_id)) WITH CHECK (current_user_is_workspace_member(workspace_id)); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='messages' AND policyname='message_tenant_policy') THEN CREATE POLICY message_tenant_policy ON messages USING (EXISTS(SELECT 1 FROM public.conversations c WHERE c.id=conversation_id AND public.current_user_is_workspace_member(c.workspace_id))) WITH CHECK (EXISTS(SELECT 1 FROM public.conversations c WHERE c.id=conversation_id AND public.current_user_is_workspace_member(c.workspace_id))); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='leads' AND policyname='lead_tenant_policy') THEN CREATE POLICY lead_tenant_policy ON leads USING (current_user_is_workspace_member(workspace_id)) WITH CHECK (current_user_is_workspace_member(workspace_id)); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='knowledge_items' AND policyname='knowledge_tenant_policy') THEN CREATE POLICY knowledge_tenant_policy ON knowledge_items USING (current_user_is_workspace_member(workspace_id)) WITH CHECK (current_user_is_workspace_member(workspace_id)); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='follow_up_rules' AND policyname='follow_up_tenant_policy') THEN CREATE POLICY follow_up_tenant_policy ON follow_up_rules USING (current_user_is_workspace_member(workspace_id)) WITH CHECK (current_user_is_workspace_member(workspace_id)); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='audit_logs' AND policyname='audit_tenant_policy') THEN CREATE POLICY audit_tenant_policy ON audit_logs USING (current_user_is_workspace_member(workspace_id)) WITH CHECK (current_user_is_workspace_member(workspace_id)); END IF; END $$;


-- Fresh-install equivalents of migration 002 integrity and runtime-role controls.
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='customers_id_workspace_unique') THEN ALTER TABLE customers ADD CONSTRAINT customers_id_workspace_unique UNIQUE(id,workspace_id); END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='conversations_id_workspace_unique') THEN ALTER TABLE conversations ADD CONSTRAINT conversations_id_workspace_unique UNIQUE(id,workspace_id); END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='conversations_customer_tenant_fk') THEN ALTER TABLE conversations ADD CONSTRAINT conversations_customer_tenant_fk FOREIGN KEY(customer_id,workspace_id) REFERENCES customers(id,workspace_id); END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='leads_customer_tenant_fk') THEN ALTER TABLE leads ADD CONSTRAINT leads_customer_tenant_fk FOREIGN KEY(customer_id,workspace_id) REFERENCES customers(id,workspace_id); END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='leads_conversation_tenant_fk') THEN ALTER TABLE leads ADD CONSTRAINT leads_conversation_tenant_fk FOREIGN KEY(conversation_id,workspace_id) REFERENCES conversations(id,workspace_id); END IF;
END $$;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ydeck_tenant_runtime') THEN CREATE ROLE ydeck_tenant_runtime NOLOGIN NOINHERIT; END IF; END $$;
ALTER ROLE ydeck_tenant_runtime NOLOGIN NOINHERIT;
GRANT ydeck_tenant_runtime TO CURRENT_USER;
REVOKE ALL ON FUNCTION current_user_is_workspace_member(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION current_user_is_workspace_member(UUID) TO ydeck_tenant_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON workspaces,workspace_members,workspace_invitations,channel_connections,customers,conversations,messages,leads,knowledge_items,follow_up_rules,audit_logs TO ydeck_tenant_runtime;
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['workspaces','workspace_members','workspace_invitations','channel_connections','customers','conversations','messages','leads','knowledge_items','follow_up_rules','audit_logs'] LOOP EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t); END LOOP; END $$;
