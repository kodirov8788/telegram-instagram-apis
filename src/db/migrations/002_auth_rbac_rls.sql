-- Issue #26: authentication, invitation integrity, tenant-safe foreign keys and enforced RLS.
BEGIN;
CREATE TABLE IF NOT EXISTS user_sessions (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, token_hash CHAR(64) UNIQUE NOT NULL, expires_at TIMESTAMPTZ NOT NULL, revoked_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE IF NOT EXISTS workspace_invitations (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, email VARCHAR(255) NOT NULL, role user_role NOT NULL CHECK(role <> 'owner'), token_hash CHAR(64) UNIQUE NOT NULL, invited_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TIMESTAMPTZ NOT NULL, accepted_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_workspace_invitations_workspace ON workspace_invitations(workspace_id);
DO $do$ BEGIN
 UPDATE workspace_invitations SET accepted_at=NOW() WHERE accepted_at IS NULL AND expires_at<=NOW();
 IF EXISTS (SELECT 1 FROM workspace_invitations WHERE accepted_at IS NULL GROUP BY workspace_id,lower(email) HAVING count(*)>1) THEN RAISE EXCEPTION 'migration 002 preflight: duplicate live workspace invitations exist'; END IF;
 IF EXISTS (SELECT 1 FROM conversations c JOIN customers x ON x.id=c.customer_id WHERE x.workspace_id<>c.workspace_id) THEN RAISE EXCEPTION 'migration 002 preflight: cross-tenant conversations.customer_id rows exist'; END IF;
 IF EXISTS (SELECT 1 FROM leads l JOIN customers x ON x.id=l.customer_id WHERE x.workspace_id<>l.workspace_id) THEN RAISE EXCEPTION 'migration 002 preflight: cross-tenant leads.customer_id rows exist'; END IF;
 IF EXISTS (SELECT 1 FROM leads l JOIN conversations c ON c.id=l.conversation_id WHERE l.conversation_id IS NOT NULL AND c.workspace_id<>l.workspace_id) THEN RAISE EXCEPTION 'migration 002 preflight: cross-tenant leads.conversation_id rows exist'; END IF;
END $do$;
CREATE UNIQUE INDEX IF NOT EXISTS workspace_invitations_one_live_email ON workspace_invitations(workspace_id, lower(email)) WHERE accepted_at IS NULL;
DO $do$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='customers_id_workspace_unique') THEN ALTER TABLE customers ADD CONSTRAINT customers_id_workspace_unique UNIQUE(id,workspace_id); END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='conversations_id_workspace_unique') THEN ALTER TABLE conversations ADD CONSTRAINT conversations_id_workspace_unique UNIQUE(id,workspace_id); END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='conversations_customer_tenant_fk') THEN ALTER TABLE conversations ADD CONSTRAINT conversations_customer_tenant_fk FOREIGN KEY(customer_id,workspace_id) REFERENCES customers(id,workspace_id) NOT VALID; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='leads_customer_tenant_fk') THEN ALTER TABLE leads ADD CONSTRAINT leads_customer_tenant_fk FOREIGN KEY(customer_id,workspace_id) REFERENCES customers(id,workspace_id) NOT VALID; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='leads_conversation_tenant_fk') THEN ALTER TABLE leads ADD CONSTRAINT leads_conversation_tenant_fk FOREIGN KEY(conversation_id,workspace_id) REFERENCES conversations(id,workspace_id) NOT VALID; END IF;
END $do$;
ALTER TABLE conversations VALIDATE CONSTRAINT conversations_customer_tenant_fk;
ALTER TABLE leads VALIDATE CONSTRAINT leads_customer_tenant_fk;
ALTER TABLE leads VALIDATE CONSTRAINT leads_conversation_tenant_fk;

DO $do$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ydeck_tenant_runtime_v2') THEN CREATE ROLE ydeck_tenant_runtime_v2 NOLOGIN NOINHERIT; END IF; END $do$;
ALTER ROLE ydeck_tenant_runtime_v2 NOLOGIN NOINHERIT;
GRANT ydeck_tenant_runtime_v2 TO CURRENT_USER;
CREATE OR REPLACE FUNCTION current_user_is_workspace_member(target UUID) RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$ SELECT EXISTS(SELECT 1 FROM public.workspace_members WHERE workspace_id=target AND user_id=NULLIF(current_setting('app.user_id',true),'')::uuid) $$;
REVOKE ALL ON FUNCTION current_user_is_workspace_member(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION current_user_is_workspace_member(UUID) TO ydeck_tenant_runtime_v2;
GRANT SELECT,INSERT,UPDATE,DELETE ON workspaces,workspace_members,workspace_invitations,channel_connections,customers,conversations,messages,leads,knowledge_items,follow_up_rules,audit_logs TO ydeck_tenant_runtime_v2;
DO $do$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['workspaces','workspace_members','workspace_invitations','channel_connections','customers','conversations','messages','leads','knowledge_items','follow_up_rules','audit_logs'] LOOP EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t); END LOOP; END $do$;
-- The SECURITY DEFINER membership function is owned by the migration/table owner and must
-- bypass workspace_members RLS to avoid recursively invoking member_tenant_policy.
DO $do$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['workspaces','workspace_invitations','channel_connections','customers','conversations','messages','leads','knowledge_items','follow_up_rules','audit_logs'] LOOP EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t); END LOOP; END $do$;
DO $do$ DECLARE p text; t text; c text; BEGIN FOR p,t,c IN SELECT * FROM (VALUES ('workspace_tenant_policy','workspaces','id'),('member_tenant_policy','workspace_members','workspace_id'),('invitation_tenant_policy','workspace_invitations','workspace_id'),('channel_tenant_policy','channel_connections','workspace_id'),('customer_tenant_policy','customers','workspace_id'),('conversation_tenant_policy','conversations','workspace_id'),('lead_tenant_policy','leads','workspace_id'),('knowledge_tenant_policy','knowledge_items','workspace_id'),('follow_up_tenant_policy','follow_up_rules','workspace_id'),('audit_tenant_policy','audit_logs','workspace_id')) x LOOP IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename=t AND policyname=p) THEN EXECUTE format('CREATE POLICY %I ON %I USING (current_user_is_workspace_member(%I)) WITH CHECK (current_user_is_workspace_member(%I))',p,t,c,c); END IF; END LOOP; END $do$;
DO $do$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='messages' AND policyname='message_tenant_policy') THEN CREATE POLICY message_tenant_policy ON messages USING (EXISTS(SELECT 1 FROM public.conversations c WHERE c.id=conversation_id AND public.current_user_is_workspace_member(c.workspace_id))) WITH CHECK (EXISTS(SELECT 1 FROM public.conversations c WHERE c.id=conversation_id AND public.current_user_is_workspace_member(c.workspace_id))); END IF; END $do$;
COMMIT;
