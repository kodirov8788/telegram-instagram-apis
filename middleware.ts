import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

/**
 * AUTH-02 scope: session refresh ONLY.
 *
 * Calling `supabase.auth.getUser()` here lets `@supabase/ssr` rotate an
 * expiring refresh token and rewrite the updated auth cookies onto the
 * outgoing response, so API routes see a live session on the next request
 * instead of intermittently falling back to the legacy path (or 401ing)
 * once the access token expires.
 *
 * This middleware does NOT redirect, block, or otherwise gate any route —
 * every request passes through unchanged except for its cookies. Route
 * protection / redirects are explicitly AUTH-04's job (#87); this file is
 * intentionally structured so that logic can be added here later without a
 * rewrite (see the TODO below).
 */
export async function middleware(request: NextRequest) {
  const response = NextResponse.next({ request });

  if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    const supabase = createSupabaseServerClient(request, response);
    // Result intentionally unused here — this call's only purpose is the
    // side effect of refreshing/writing auth cookies onto `response`.
    await supabase.auth.getUser();
  }

  // TODO(AUTH-04, #87): add route-protection / redirect logic here, using the
  // already-resolved session above. Do not add it before that issue.

  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
