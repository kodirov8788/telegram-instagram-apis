import { NextRequest, NextResponse } from 'next/server';
import { authenticate } from '@/lib/auth/session';
import { query } from '@/lib/db';
import { errorResponse } from '@/lib/http/validation';

/**
 * GET /api/workspaces — workspace discovery.
 *
 * Authenticated only (`authenticate`, NOT `withLiveAuthorization`): this is
 * deliberately the one route a client can call without already knowing an
 * `x-workspace-id`, since that header is otherwise required everywhere else
 * (see `selectedWorkspace()` in `src/lib/auth/session.ts`). Without this
 * route there is no way for a freshly authenticated client to discover
 * which workspace(s) it belongs to.
 *
 * Tenant-safe by construction: the query is filtered on
 * `workspace_members.user_id = $1` (the authenticated principal's own id),
 * so it can only ever return workspaces the caller actually belongs to.
 *
 * Ordering is deterministic: oldest membership first, by
 * `workspace_members.created_at`, tie-broken by `workspace_id` for
 * full determinism if two memberships share a timestamp.
 */
export async function GET(req: NextRequest) {
  try {
    const principal = await authenticate(req);
    const result = await query(
      `SELECT w.id, w.name, m.role
       FROM workspace_members m
       JOIN workspaces w ON w.id = m.workspace_id
       WHERE m.user_id = $1
       ORDER BY m.created_at ASC, m.workspace_id ASC`,
      [principal.userId],
    );
    const workspaces = result.rows.map(row => ({ id: row.id, name: row.name, role: row.role }));
    return NextResponse.json({ workspaces });
  } catch (error) {
    return errorResponse(error);
  }
}
