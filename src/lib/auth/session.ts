import type { NextRequest } from 'next/server';
import { query, tenantTransaction, type DbClient } from '@/lib/db';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { can, type Permission, type Role } from './permissions';
import { HttpError, uuid } from '../http/validation';

export interface Principal { userId: string; email: string; }
export interface WorkspacePrincipal extends Principal { workspaceId: string; role: Role; }

/**
 * Resolve the current Supabase Auth session, if any. Uses `getUser()` rather
 * than `getSession()` — `getSession()` merely decodes the (unverified)
 * cookie-borne JWT, while `getUser()` revalidates the token against
 * Supabase's auth server, which is the trust boundary we need server-side.
 * Per AUTH-01, `auth.users.id` equals `public.users.id`, so no extra lookup
 * is needed to map the Supabase user onto our `Principal` shape.
 */
async function authenticateViaSupabase(request: NextRequest): Promise<Principal | null> {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) return null;
  try {
    const supabase = createSupabaseServerClient(request);
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user || !data.user.email) return null;
    return { userId: data.user.id, email: data.user.email };
  } catch {
    return null;
  }
}

/** Resolve the calling principal from the Supabase Auth session (AUTH-05: legacy cookie auth removed). */
export async function authenticate(request: NextRequest): Promise<Principal> {
  const principal = await authenticateViaSupabase(request);
  if (!principal) throw new HttpError(401, 'Authentication required');
  return principal;
}

export function selectedWorkspace(request: NextRequest): string {
  const value = request.headers.get('x-workspace-id') ?? request.nextUrl.searchParams.get('workspace_id') ?? request.nextUrl.searchParams.get('id');
  const parsed = uuid.safeParse(value);
  if (!parsed.success) throw new HttpError(400, 'A valid workspace selector is required');
  return parsed.data;
}

export async function authorize(request: NextRequest, permission: Permission): Promise<WorkspacePrincipal> {
  const principal = await authenticate(request);
  const workspaceId = selectedWorkspace(request);
  const result = await query('SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [workspaceId, principal.userId]);
  const role = result.rows[0]?.role as Role | undefined;
  if (!role || !can(role, permission)) throw new HttpError(403, 'Forbidden');
  return { ...principal, workspaceId, role };
}

/** Authorize from a locked, live membership row and execute on that same RLS connection. */
export async function withLiveAuthorization<T>(
  request: NextRequest,
  permission: Permission,
  operation: (principal: WorkspacePrincipal, client: DbClient) => Promise<T>,
): Promise<T> {
  const principal = await authenticate(request);
  const workspaceId = selectedWorkspace(request);
  return tenantTransaction(principal.userId, async client => {
    const result = await client.query(
      'SELECT role FROM public.workspace_members WHERE workspace_id = $1 AND user_id = $2 FOR SHARE',
      [workspaceId, principal.userId],
    );
    const role = result.rows[0]?.role as Role | undefined;
    if (!role || !can(role, permission)) throw new HttpError(403, 'Forbidden');
    return operation({ ...principal, workspaceId, role }, client);
  });
}
