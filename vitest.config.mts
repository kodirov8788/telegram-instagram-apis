import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    environment: 'node',
    // AUTH-05: authenticate() resolves only via Supabase now, and gates on
    // these two env vars being present before it even calls
    // createSupabaseServerClient() (see authenticateViaSupabase() in
    // src/lib/auth/session.ts). Every route test that mocks a Supabase
    // session (via supabase-session-mock.ts) needs them set, so set them
    // globally here rather than repeating it in every test file.
    env: {
      NEXT_PUBLIC_SUPABASE_URL: 'https://test.supabase.co',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'test-anon-key',
    },
  },
});
