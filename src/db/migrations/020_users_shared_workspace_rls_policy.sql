-- Issue: `users` has row-level security ENABLED (relrowsecurity = true) but
-- had ZERO policies defined on it — in Postgres, RLS-enabled + no policy
-- means every row is denied by default to any non-superuser/non-owner role,
-- regardless of table-level GRANTs (confirmed live: after granting SELECT
-- to ydeck_tenant_runtime_v2 in migration 019, `GET /api/workspace/members`
-- still silently returned zero rows instead of the real member, because
-- RLS filtered out even the querying user's own row).
--
-- Policy: a `users` row is visible to the tenant-runtime role only if that
-- user shares at least one workspace membership with the caller (identified
-- via app.user_id, same convention as every other tenant policy in this
-- schema). This is deliberately broader than "see only your own row" —
-- the real use case (team member lists showing every member's email/name)
-- requires seeing OTHER members' rows too, not just your own. Still fully
-- tenant-scoped: a user with no shared workspace is never visible.

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'users' AND policyname = 'users_shared_workspace_policy'
  ) THEN
    CREATE POLICY users_shared_workspace_policy ON public.users
      FOR SELECT
      USING (
        EXISTS (
          SELECT 1
          FROM public.workspace_members mine
          JOIN public.workspace_members theirs ON theirs.workspace_id = mine.workspace_id
          WHERE mine.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
            AND theirs.user_id = users.id
        )
      );
  END IF;
END $do$;
