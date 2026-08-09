-- Issue #84 (AUTH-01): redefine `users.id` around Supabase Auth's
-- `auth.users.id`, with a trigger-based sync so `public.users` rows are
-- created/kept in sync automatically on signup/profile update.
--
-- Production has ZERO rows in users/user_sessions/workspace_members/
-- workspace_invitations (confirmed live before writing this migration), so
-- this is a clean-slate schema change — no re-keying of existing rows is
-- needed or attempted.
--
-- What changes:
--   1. `users.id` no longer self-generates via uuid_generate_v4(); every
--      row's id must equal the corresponding `auth.users.id`. The default
--      is dropped so a bare INSERT without an explicit id fails loudly
--      instead of manufacturing an id that can never match auth.users.
--   2. `users.id` gets `FOREIGN KEY REFERENCES auth.users(id) ON DELETE
--      CASCADE` — deleting the Supabase Auth identity cascades into
--      public.users, and from there into every table that already
--      references users(id) (workspace_members, user_sessions,
--      workspace_invitations.invited_by, conversations.assigned_user_id,
--      messages.sender_user_id, leads.assigned_user_id — all unchanged,
--      still pointing at users(id), still valid, per the FK verification
--      in the PR description).
--   3. A SECURITY DEFINER trigger function on `auth.users` upserts a
--      matching `public.users` row (email, full_name) on INSERT or UPDATE
--      of auth.users, so every authenticated identity has a row in
--      public.users without any application-level sync code. Idempotent:
--      CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS/CREATE TRIGGER,
--      and the upsert itself is ON CONFLICT (id) DO UPDATE.
--
-- What does NOT change in this migration (explicit non-goals, AUTH-05):
--   - `password_hash` stays (still used by the current bcrypt login path
--     until AUTH-05 removes it once the new path is validated).
--   - `user_sessions` is untouched.
--   - No application code changes.
--
-- Requires the `auth` schema (Supabase Auth's own schema, present by
-- default in every real Supabase project). This migration will fail on a
-- bare Postgres instance with no `auth.users` table — that's expected; see
-- the PR description for how live-DB validation stood up a throwaway
-- stand-in auth.users table for local testing only (not part of this file).

-- 1. Drop the self-generating default. Safe on an empty table; a non-empty
--    table would still have this statement succeed (it only affects future
--    inserts), but production has 0 rows so there is nothing to reconcile.
ALTER TABLE public.users ALTER COLUMN id DROP DEFAULT;

-- 2. Anchor public.users identity to Supabase Auth identity.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'users_id_auth_users_fkey'
      AND conrelid = 'public.users'::regclass
  ) THEN
    ALTER TABLE public.users
      ADD CONSTRAINT users_id_auth_users_fkey
      FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;
END $$;

-- 3. Sync trigger: auth.users -> public.users (email, full_name).
--    CREATE OR REPLACE makes the function definition idempotent; the
--    trigger is dropped and recreated for the same reason. The upsert
--    itself is idempotent via ON CONFLICT (id) DO UPDATE, so re-running
--    this migration (or re-firing the trigger for the same auth user) is
--    always a no-op beyond refreshing email/full_name.
CREATE OR REPLACE FUNCTION public.sync_auth_user_to_public_users()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  INSERT INTO public.users (id, email, full_name)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data ->> 'full_name', split_part(NEW.email, '@', 1))
  )
  ON CONFLICT (id) DO UPDATE
    SET email = EXCLUDED.email,
        full_name = COALESCE(EXCLUDED.full_name, public.users.full_name);
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS sync_auth_user_to_public_users_trigger ON auth.users;

CREATE TRIGGER sync_auth_user_to_public_users_trigger
  AFTER INSERT OR UPDATE ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_auth_user_to_public_users();

REVOKE ALL ON FUNCTION public.sync_auth_user_to_public_users() FROM PUBLIC;
