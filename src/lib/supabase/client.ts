import { createBrowserClient } from '@supabase/ssr';

/**
 * Browser-side Supabase client. Safe to call repeatedly (e.g. per component) —
 * `createBrowserClient` reuses a single underlying client per module instance.
 * Only relies on the public URL/anon key, never a service-role secret.
 */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
