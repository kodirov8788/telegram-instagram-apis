/**
 * Shared test double for `authenticateViaSupabase()` (AUTH-05).
 *
 * `authenticate()` now resolves ONLY via
 * `createSupabaseServerClient(request).auth.getUser()` — the legacy cookie/
 * `user_sessions` fallback was removed in AUTH-05. This module is the one
 * shared mock for that call, imported by every route test that needs a
 * simulated authenticated principal.
 *
 * Usage (per consuming test file):
 *   vi.mock('@/lib/supabase/server', async () => {
 *     const m = await import('@/lib/auth/__tests__/supabase-session-mock');
 *     return { createSupabaseServerClient: m.mockCreateSupabaseServerClient };
 *   });
 *   ...
 *   import { setMockSupabaseUser } from '@/lib/auth/__tests__/supabase-session-mock';
 *   beforeEach(() => setMockSupabaseUser({ id: uid, email: 'u@test.dev' }));
 *
 * (The dynamic `await import(...)` inside the factory — rather than a normal
 * top-level import referenced from the factory — is required because
 * `vi.mock` factories are hoisted above all imports; referencing an
 * ordinarily-imported binding there throws a TDZ error.)
 */

export const supabaseSessionMock: { current: null | { id: string; email: string } } = {
  current: null,
};

export function setMockSupabaseUser(user: { id: string; email: string } | null) {
  supabaseSessionMock.current = user;
}

export function mockCreateSupabaseServerClient() {
  return {
    auth: {
      getUser: async () =>
        supabaseSessionMock.current
          ? { data: { user: supabaseSessionMock.current }, error: null }
          : { data: { user: null }, error: { message: 'no session' } },
    },
  };
}
