import { createHash, randomBytes } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { query, type DbClient } from '@/lib/db';
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

export async function authenticate(request: NextRequest): Promise<Principal> {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (!token) throw new HttpError(401, 'Authentication required');
  const result = await query(
    `SELECT s.user_id, u.email FROM user_sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > NOW()`, [hash(token)]);
  const row = result.rows[0];
  if (!row) throw new HttpError(401, 'Invalid or expired session');
  return { userId: row.user_id, email: row.email };
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

export async function revokeSession(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (token) await query('UPDATE user_sessions SET revoked_at = NOW() WHERE token_hash = $1', [hash(token)]);
}

export const cookieOptions = (expires?: Date) => ({ httpOnly: true, secure: true, sameSite: 'lax' as const, path: '/', ...(expires ? { expires } : {}) });
