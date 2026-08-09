import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/db', () => ({ query: vi.fn(), default: { connect: vi.fn() } }));
vi.mock('@/lib/supabase/server', async () => {
  const m = await import('@/lib/auth/__tests__/supabase-session-mock');
  return { createSupabaseServerClient: m.mockCreateSupabaseServerClient };
});
import { query } from '@/lib/db';
import { GET as workspacesGet } from '../workspaces/route';
import { setMockSupabaseUser } from '@/lib/auth/__tests__/supabase-session-mock';

const db = vi.mocked(query);
const uid = 'user-1';
const otherUid = 'user-2';
const wid1 = '11111111-1111-4111-8111-111111111111';
const wid2 = '22222222-2222-4222-8222-222222222222';

const req = () => new NextRequest('https://app.test/api/workspaces');

beforeEach(() => { db.mockReset(); setMockSupabaseUser({ id: uid, email: 'u@test.dev' }); });

describe('GET /api/workspaces', () => {
  it('returns 401 when unauthenticated', async () => {
    setMockSupabaseUser(null);
    const res = await workspacesGet(new NextRequest('https://app.test/api/workspaces'));
    expect(res.status).toBe(401);
  });

  it('returns an empty array when the user has zero workspaces', async () => {
    db.mockResolvedValueOnce({ rows: [] } as never); // membership query
    const res = await workspacesGet(req());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ workspaces: [] });
  });

  it('returns the single workspace when the user has exactly one', async () => {
    db.mockResolvedValueOnce({ rows: [{ id: wid1, name: 'Acme', role: 'owner' }] } as never);
    const res = await workspacesGet(req());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ workspaces: [{ id: wid1, name: 'Acme', role: 'owner' }] });
  });

  it('returns multiple workspaces in deterministic order', async () => {
    db.mockResolvedValueOnce({
      rows: [
        { id: wid1, name: 'Acme', role: 'owner' },
        { id: wid2, name: 'Beta', role: 'support_operator' },
      ],
    } as never);
    const res = await workspacesGet(req());
    const body = await res.json();
    expect(body.workspaces).toEqual([
      { id: wid1, name: 'Acme', role: 'owner' },
      { id: wid2, name: 'Beta', role: 'support_operator' },
    ]);
    expect(db).toHaveBeenLastCalledWith(expect.stringContaining('ORDER BY m.created_at ASC, m.workspace_id ASC'), [uid]);
  });

  it('is tenant-safe: filters membership query by the authenticated user id, never another user\'s', async () => {
    setMockSupabaseUser({ id: otherUid, email: 'u2@test.dev' });
    db.mockResolvedValueOnce({ rows: [] } as never);
    await workspacesGet(req());
    expect(db).toHaveBeenLastCalledWith(expect.stringContaining('WHERE m.user_id = $1'), [otherUid]);
  });
});
