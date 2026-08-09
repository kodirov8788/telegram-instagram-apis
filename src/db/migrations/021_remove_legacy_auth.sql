-- AUTH-05: retire the custom bcrypt/session-cookie auth system now that
-- Supabase Auth (AUTH-01 through AUTH-04) is fully validated end-to-end in
-- production. This is the LAST auth migration — no code path in src/
-- references `password_hash` or `user_sessions` after this lands (see
-- src/lib/auth/session.ts, which now authenticates exclusively via
-- createSupabaseServerClient(...).auth.getUser()).
--
-- Idempotent: IF EXISTS guards make this safe to re-run.

DROP TABLE IF EXISTS user_sessions;

ALTER TABLE users DROP COLUMN IF EXISTS password_hash;
