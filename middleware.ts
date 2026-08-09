import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

/**
 * Public page paths that must never be gated by the auth/workspace redirect
 * below — the pages themselves don't exist yet for some of these (UI-03,
 * #92, builds them), but the redirect *targets* must already resolve here.
 * `/api/*` is handled separately (see `isApiPath`): every API route already
 * enforces its own auth via `authenticate()` / `withLiveAuthorization`
 * (`src/lib/auth/session.ts`), which remains the real source of truth for
 * tenant access — this middleware redirect is a page-navigation UX
 * convenience only, not a security boundary.
 */
const PUBLIC_PAGE_PATHS = ['/login', '/signup', '/onboarding'];

function isApiPath(pathname: string) {
  return pathname.startsWith('/api/');
}

function isPublicPagePath(pathname: string) {
  return PUBLIC_PAGE_PATHS.some(p => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * AUTH-04 (#87) route protection.
 *
 * Extends AUTH-02's refresh-only middleware with page-level redirects:
 *  - unauthenticated                -> `/login`
 *  - authenticated, zero workspaces -> `/onboarding`
 *  - authenticated, has workspace(s) -> pass through
 *
 * Workspace membership is discovered by calling this app's own
 * `GET /api/workspaces` (forwarding the request's cookies) rather than
 * querying Postgres directly — middleware runs on the Edge runtime, which
 * cannot use the `pg` connection pool the rest of the app relies on, and
 * `/api/workspaces` already implements the exact tenant-safe membership
 * check this redirect needs.
 */
export async function middleware(request: NextRequest) {
  const response = NextResponse.next({ request });

  if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    const supabase = createSupabaseServerClient(request, response);
    // Result intentionally unused here — this call's only purpose is the
    // side effect of refreshing/writing auth cookies onto `response`.
    await supabase.auth.getUser();
  }

  const { pathname } = request.nextUrl;

  if (isApiPath(pathname) || isPublicPagePath(pathname)) {
    return response;
  }

  const cookieHeader = request.headers.get('cookie') ?? '';
  // Forward the (possibly just-refreshed) auth cookies onto the internal
  // call so it observes the same session this request will.
  const forwardedCookie = response.headers.get('set-cookie') ? request.cookies.toString() : cookieHeader;

  let workspaceCount: number | null = null;
  try {
    const workspacesRes = await fetch(new URL('/api/workspaces', request.url), {
      headers: { cookie: forwardedCookie },
    });
    if (workspacesRes.status === 401) {
      const loginUrl = new URL('/login', request.url);
      loginUrl.searchParams.set('redirect', pathname);
      return NextResponse.redirect(loginUrl);
    }
    if (workspacesRes.ok) {
      const data = (await workspacesRes.json()) as { workspaces: unknown[] };
      workspaceCount = data.workspaces?.length ?? 0;
    }
  } catch {
    // If the workspace-discovery call itself fails (network/infra hiccup),
    // fail open on this UX redirect rather than locking users out of pages
    // whose data-fetching will surface the real error anyway — server-side
    // authorization on every API call remains the actual enforcement point.
    return response;
  }

  if (workspaceCount === 0) {
    return NextResponse.redirect(new URL('/onboarding', request.url));
  }

  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
