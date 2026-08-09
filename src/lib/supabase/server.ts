import { createServerClient, type CookieOptions } from '@supabase/ssr';
import type { NextRequest, NextResponse } from 'next/server';

/**
 * Server-side Supabase client bound to a request's cookies (App Router / Route
 * Handler / Middleware pattern for `@supabase/ssr`).
 *
 * Reads always come from `request.cookies`. Writes (session refresh) are only
 * applied when a `response` is supplied — Route Handlers that merely need to
 * resolve the current user (e.g. `authenticate()`) can omit it and get a
 * read-only client; `middleware.ts` supplies both so refreshed auth cookies
 * get written back onto the outgoing response.
 *
 * `setAll` mutates `request.cookies` in addition to `response.cookies` —
 * the canonical `@supabase/ssr` middleware pattern — so any code that reads
 * `request.cookies` later in the same middleware/request chain (e.g. a
 * future AUTH-04 route-protection check) sees the just-refreshed values
 * instead of the stale pre-refresh cookie.
 */
export function createSupabaseServerClient(request: NextRequest, response?: NextResponse) {
  return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        if (!response) return;
        for (const { name, value, options } of cookiesToSet) {
          request.cookies.set(name, value);
          response.cookies.set(name, value, options);
        }
      },
    },
  });
}
