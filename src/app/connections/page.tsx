import { cookies } from "next/headers";
import { ConnectionsPageClient } from "./PageClient";

/**
 * Server-component wrapper — the only job of this file is to force this
 * route out of static generation. `ConnectionsPageClient` is a 'use client'
 * component with zero server-rendered data of its own, so Next.js was
 * treating the whole route as fully static (prerendered at build time,
 * cacheable by Vercel's CDN). That meant this auth/workspace-gated page
 * could be served straight from cache WITHOUT middleware.ts ever running
 * to redirect an unauthenticated or wrong-workspace-state visitor —
 * confirmed live in production (a request with no session at all still
 * got a cached 200, not a redirect to /login).
 *
 * Calling `cookies()` from `next/headers` in a Server Component is the
 * standard, documented way to opt a route out of static generation: it's
 * an inherently per-request API, so Next.js can no longer prerender this
 * route at build time. The returned value is intentionally unused — this
 * call exists purely for its dynamic-rendering side effect.
 */
export default async function ConnectionsPage() {
  cookies();
  return <ConnectionsPageClient />;
}
