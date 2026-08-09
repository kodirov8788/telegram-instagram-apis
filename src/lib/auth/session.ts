import { createHash, randomBytes } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { query, tenantTransaction, type DbClient } from '@/lib/db';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { can, type Permission, type Role } from './permissions';
import { HttpError, uuid } from '../http/validation';

export const SESSION_COOKIE = 'session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

export interface Principal { userId: string; email: string; }
export interface WorkspacePrincipal extends Principal { workspaceId: string; role: Role; }

export async function createSession(userId: string, client: DbClient = { query }) {
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await client.query('INSERT INTO user_sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)', [userId, hash(token), expiresAt]);
  return { token, expiresAt };
}

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

/** Legacy custom-cookie session lookup (pre-Supabase-Auth). Retained until AUTH-05. */
async function authenticateViaLegacyCookie(request: NextRequest, client: DbClient): Promise<Principal> {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (!token) throw new HttpError(401, 'Authentication required');
  const result = await client.query(
    `SELECT s.user_id, u.email FROM user_sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > NOW()`, [hash(token)]);
  const row = result.rows[0];
  if (!row) throw new HttpError(401, 'Invalid or expired session');
  return { userId: row.user_id, email: row.email };
}

/**
 * Resolve the calling principal. Tries a Supabase Auth session first (the
 * AUTH-02+ path); if none is present, falls back to the legacy custom-cookie
 * `user_sessions` lookup so pre-existing (theoretical, zero-production-user)
 * flows keep working until AUTH-05 removes them. Both paths return the same
 * `Principal` shape, so every downstream call site (`authorize`,
 * `withLiveAuthorization`, and every route handler) is unaffected.
 */
export async function authenticate(request: NextRequest, client: DbClient = { query }): Promise<Principal> {
  const supabasePrincipal = await authenticateViaSupabase(request);
  if (supabasePrincipal) return supabasePrincipal;
  return authenticateViaLegacyCookie(request, client);
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

export async function revokeSession(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (token) await query('UPDATE user_sessions SET revoked_at = NOW() WHERE token_hash = $1', [hash(token)]);
}

export const cookieOptions = (expires?: Date) => ({ httpOnly: true, secure: true, sameSite: 'lax' as const, path: '/', ...(expires ? { expires } : {}) });
