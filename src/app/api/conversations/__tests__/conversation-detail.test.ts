import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/db', () => ({
  query: vi.fn(),
  tenantTransaction: vi.fn(async (_userId: string, operation: (client: { query: typeof query }) => unknown) => operation({ query })),
  default: { connect: vi.fn() },
}));
vi.mock('@/lib/supabase/server', async () => {
  const m = await import('@/lib/auth/__tests__/supabase-session-mock');
  return { createSupabaseServerClient: m.mockCreateSupabaseServerClient };
});

import { query } from '@/lib/db';
import { GET as detailGet } from '../[id]/route';
import { setMockSupabaseUser } from '@/lib/auth/__tests__/supabase-session-mock';

const db = vi.mocked(query);

const wid = '11111111-1111-4111-8111-111111111111';
const convId = '22222222-2222-4222-8222-222222222222';
const otherWid = '33333333-3333-4333-8333-333333333333';
const headers = { 'x-workspace-id': wid, 'content-type': 'application/json' };

const member = (role: string) => db.mockResolvedValueOnce({ rows: [{ role }] } as never);

beforeEach(() => { db.mockReset(); setMockSupabaseUser({ id: 'user-1', email: 'u@test.dev' }); });

describe('GET /api/conversations/:id', () => {
  const ctx = { params: Promise.resolve({ id: convId }) };

  it('requires authentication', async () => {
    setMockSupabaseUser(null);
    const res = await detailGet(new NextRequest(`https://app.test/api/conversations/${convId}`, { headers: { 'x-workspace-id': wid } }), ctx);
    expect(res.status).toBe(401);
  });

  it('allows any workspace role to read', async () => {
    member('read_only_analyst');
    db.mockResolvedValueOnce({ rows: [{ id: convId, workspace_id: wid, full_name: 'Jane' }] } as never);
    db.mockResolvedValueOnce({ rows: [{ id: 'm1', conversation_id: convId, sender: 'customer', content: 'hi' }] } as never);
    const res = await detailGet(new NextRequest(`https://app.test/api/conversations/${convId}`, { headers }), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.conversation.id).toBe(convId);
    expect(body.messages).toHaveLength(1);
    expect(db.mock.calls[1][1]).toEqual([convId, wid]);
    expect(db.mock.calls[2][1]).toEqual([convId]);
  });

  it('404s for a cross-tenant conversation id', async () => {
    member('owner');
    db.mockResolvedValueOnce({ rows: [] } as never); // conversation lookup scoped to otherWid finds nothing
    const res = await detailGet(new NextRequest(`https://app.test/api/conversations/${convId}`, { headers: { ...headers, 'x-workspace-id': otherWid } }), ctx);
    expect(res.status).toBe(404);
  });

  it('rejects an invalid id param', async () => {
    const badCtx = { params: Promise.resolve({ id: 'not-a-uuid' }) };
    const res = await detailGet(new NextRequest(`https://app.test/api/conversations/not-a-uuid`, { headers }), badCtx);
    expect(res.status).toBe(400);
  });
});
