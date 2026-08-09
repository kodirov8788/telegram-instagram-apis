import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

/**
 * Auth-only page paths (no workspace requirement to reach them) — used
 * to decide the "already authenticated, don't show me the login form"
 * redirect. `/onboarding` is deliberately NOT in this list: an
 * authenticated user with an existing workspace can still visit it to
 * create another one, so it isn't gated away like `/login`/`/signup` are.
 * `/api/*` is handled separately (see `isApiPath`): every API route already
 * enforces its own auth via `authenticate()` / `withLiveAuthorization`
 * (`src/lib/auth/session.ts`), which remains the real source of truth for
 * tenant access — this middleware redirect is a page-navigation UX
 * convenience only, not a security boundary.
 */
const AUTH_ONLY_PAGE_PATHS = ['/login', '/signup'];
const ONBOARDING_PATH = '/onboarding';
const DEFAULT_AUTHENTICATED_LANDING = '/inbox';

function isApiPath(pathname: string) {
  return pathname.startsWith('/api/');
}

function isAuthOnlyPagePath(pathname: string) {
  return AUTH_ONLY_PAGE_PATHS.some(p => pathname === p || pathname.startsWith(`${p}/`));
}

function isOnboardingPath(pathname: string) {
  return pathname === ONBOARDING_PATH || pathname.startsWith(`${ONBOARDING_PATH}/`);
}

/**
 * `NextResponse.redirect(url)` builds a brand-new response object — it does
 * NOT carry over any `Set-Cookie` header the earlier `supabase.auth.getUser()`
 * call may have written onto `response` (e.g. a rotated refresh token). Per
 * independent review of #109: without this, a token rotation that happened
 * on this exact request would be silently dropped on the /login and
 * /onboarding redirect paths, leaving the client with its old, soon-to-expire
 * cookie. Copying the header across preserves the refresh regardless of
 * which response path this request takes.
 */
function redirectPreservingRefreshedCookies(url: URL, refreshedResponse: NextResponse) {
  const redirectResponse = NextResponse.redirect(url);
  const setCookie = refreshedResponse.headers.get('set-cookie');
  if (setCookie) redirectResponse.headers.set('set-cookie', setCookie);
  return redirectResponse;
}

/**
 * AUTH-04 (#87) route protection, extended in UI-03 (#92) to also redirect
 * an already-authenticated visitor away from `/login`/`/signup`.
 *
 *  - unauthenticated, protected route        -> `/login?redirect=<path>`
 *  - unauthenticated, `/login` or `/signup`   -> pass through (that's where they belong)
 *  - authenticated, `/login` or `/signup`     -> redirect into the app (workspace-aware)
 *  - authenticated, zero workspaces           -> `/onboarding` (except `/onboarding` itself)
 *  - authenticated, has workspace(s)          -> pass through
 *
 * Workspace membership is discovered by calling this app's own
 * `GET /api/workspaces` (forwarding the request's cookies) rather than
 * querying Postgres directly — middleware runs on the Edge runtime, which
 * cannot use the `pg` connection pool the rest of the app relies on, and
 * `/api/workspaces` already implements the exact tenant-safe membership
 * check this redirect needs. It is also how this middleware learns whether
 * the visitor is authenticated at all (a 401 from that route = no session).
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

  if (isApiPath(pathname)) {
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
      // Unauthenticated: /login and /signup are exactly where they should
      // be; everything else redirects there, preserving the intended path.
      if (isAuthOnlyPagePath(pathname)) return response;
      const loginUrl = new URL('/login', request.url);
      loginUrl.searchParams.set('redirect', pathname);
      return redirectPreservingRefreshedCookies(loginUrl, response);
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

  // Authenticated from here on.

  if (isAuthOnlyPagePath(pathname)) {
    // Already signed in — /login and /signup have nothing left to offer.
    const destination = new URL(
      workspaceCount === 0 ? ONBOARDING_PATH : DEFAULT_AUTHENTICATED_LANDING,
      request.url
    );
    return redirectPreservingRefreshedCookies(destination, response);
  }

  if (workspaceCount === 0 && !isOnboardingPath(pathname)) {
    return redirectPreservingRefreshedCookies(new URL(ONBOARDING_PATH, request.url), response);
  }

  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
