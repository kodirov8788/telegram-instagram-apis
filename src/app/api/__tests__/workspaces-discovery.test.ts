import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/db', () => ({ query: vi.fn(), default: { connect: vi.fn() } }));
import { query } from '@/lib/db';
import { GET as workspacesGet } from '../workspaces/route';

const db = vi.mocked(query);
const uid = 'user-1';
const otherUid = 'user-2';
const wid1 = '11111111-1111-4111-8111-111111111111';
const wid2 = '22222222-2222-4222-8222-222222222222';

const cookieHeaders = { cookie: `session=${'a'.repeat(64)}` };
const req = () => new NextRequest('https://app.test/api/workspaces', { headers: cookieHeaders });
const session = (userId = uid) => db.mockResolvedValueOnce({ rows: [{ user_id: userId, email: 'u@test.dev' }] } as never);

beforeEach(() => db.mockReset());

describe('GET /api/workspaces', () => {
  it('returns 401 when unauthenticated', async () => {
    db.mockResolvedValueOnce({ rows: [] } as never); // legacy session lookup miss
    const res = await workspacesGet(new NextRequest('https://app.test/api/workspaces'));
    expect(res.status).toBe(401);
  });

  it('returns an empty array when the user has zero workspaces', async () => {
    session();
    db.mockResolvedValueOnce({ rows: [] } as never); // membership query
    const res = await workspacesGet(req());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ workspaces: [] });
  });

  it('returns the single workspace when the user has exactly one', async () => {
    session();
    db.mockResolvedValueOnce({ rows: [{ id: wid1, name: 'Acme', role: 'owner' }] } as never);
    const res = await workspacesGet(req());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ workspaces: [{ id: wid1, name: 'Acme', role: 'owner' }] });
  });

  it('returns multiple workspaces in deterministic order', async () => {
    session();
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
    session(otherUid);
    db.mockResolvedValueOnce({ rows: [] } as never);
    await workspacesGet(req());
    expect(db).toHaveBeenLastCalledWith(expect.stringContaining('WHERE m.user_id = $1'), [otherUid]);
  });
});
