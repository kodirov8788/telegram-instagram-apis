-- Issue #26: authentication, membership invitations, and tenant RLS.
BEGIN;
CREATE TABLE IF NOT EXISTS user_sessions (
 id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 token_hash CHAR(64) UNIQUE NOT NULL, expires_at TIMESTAMPTZ NOT NULL, revoked_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);
CREATE TABLE IF NOT EXISTS workspace_invitations (
 id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 email VARCHAR(255) NOT NULL, role user_role NOT NULL CHECK(role <> 'owner'), token_hash CHAR(64) UNIQUE NOT NULL,
 invited_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TIMESTAMPTZ NOT NULL, accepted_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE INDEX IF NOT EXISTS idx_workspace_invitations_workspace ON workspace_invitations(workspace_id);
-- Composite keys prevent relationships from crossing tenant boundaries.
ALTER TABLE customers ADD CONSTRAINT customers_id_workspace_unique UNIQUE (id, workspace_id);
ALTER TABLE conversations ADD CONSTRAINT conversations_id_workspace_unique UNIQUE (id, workspace_id);
ALTER TABLE conversations ADD CONSTRAINT conversations_customer_tenant_fk FOREIGN KEY (customer_id, workspace_id) REFERENCES customers(id, workspace_id);
ALTER TABLE leads ADD CONSTRAINT leads_customer_tenant_fk FOREIGN KEY (customer_id, workspace_id) REFERENCES customers(id, workspace_id);
ALTER TABLE leads ADD CONSTRAINT leads_conversation_tenant_fk FOREIGN KEY (conversation_id, workspace_id) REFERENCES conversations(id, workspace_id);
CREATE OR REPLACE FUNCTION current_user_is_workspace_member(target UUID) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$ SELECT EXISTS(SELECT 1 FROM workspace_members
 WHERE workspace_id=target AND user_id=NULLIF(current_setting('app.user_id',true),'')::uuid) $$;
DO $do$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['users','user_sessions','workspaces','workspace_members','workspace_invitations','channel_connections','customers','conversations','messages','leads','knowledge_items','follow_up_rules','audit_logs'] LOOP EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t); END LOOP; END $do$;
CREATE POLICY user_self_policy ON users USING (id=NULLIF(current_setting('app.user_id',true),'')::uuid);
CREATE POLICY session_self_policy ON user_sessions USING (user_id=NULLIF(current_setting('app.user_id',true),'')::uuid);
CREATE POLICY message_tenant_policy ON messages USING (EXISTS(SELECT 1 FROM conversations c WHERE c.id=conversation_id AND current_user_is_workspace_member(c.workspace_id)));
DO $do$ DECLARE p text; t text; c text; BEGIN
 FOR p,t,c IN SELECT * FROM (VALUES
 ('workspace_tenant_policy','workspaces','id'),('member_tenant_policy','workspace_members','workspace_id'),
 ('invitation_tenant_policy','workspace_invitations','workspace_id'),('channel_tenant_policy','channel_connections','workspace_id'),
 ('customer_tenant_policy','customers','workspace_id'),('conversation_tenant_policy','conversations','workspace_id'),
 ('lead_tenant_policy','leads','workspace_id'),('knowledge_tenant_policy','knowledge_items','workspace_id'),
 ('follow_up_tenant_policy','follow_up_rules','workspace_id'),('audit_tenant_policy','audit_logs','workspace_id')) x LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename=t AND policyname=p) THEN
   EXECUTE format('CREATE POLICY %I ON %I USING (current_user_is_workspace_member(%I))',p,t,c);
  END IF;
 END LOOP;
END $do$;
COMMIT;
