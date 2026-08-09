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
const leadId = '22222222-2222-4222-8222-222222222222';
const otherWid = '33333333-3333-4333-8333-333333333333';
const headers = { 'x-workspace-id': wid, 'content-type': 'application/json' };

const member = (role: string) => db.mockResolvedValueOnce({ rows: [{ role }] } as never);

beforeEach(() => { db.mockReset(); setMockSupabaseUser({ id: 'user-1', email: 'u@test.dev' }); });

describe('GET /api/leads/:id', () => {
  const ctx = { params: Promise.resolve({ id: leadId }) };

  it('requires authentication', async () => {
    setMockSupabaseUser(null);
    const res = await detailGet(new NextRequest(`https://app.test/api/leads/${leadId}`, { headers: { 'x-workspace-id': wid } }), ctx);
    expect(res.status).toBe(401);
  });

  it('rejects a role without leads:read', async () => {
    member('support_operator');
    const res = await detailGet(new NextRequest(`https://app.test/api/leads/${leadId}`, { headers }), ctx);
    expect(res.status).toBe(403);
  });

  it('returns the lead scoped by workspace_id', async () => {
    member('sales_manager');
    db.mockResolvedValueOnce({ rows: [{ id: leadId, workspace_id: wid, full_name: 'Jane', status: 'qualified' }] } as never);
    const res = await detailGet(new NextRequest(`https://app.test/api/leads/${leadId}`, { headers }), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lead.id).toBe(leadId);
    expect(db.mock.calls[1][1]).toEqual([leadId, wid]);
  });

  it('404s for a cross-tenant lead id', async () => {
    member('owner');
    db.mockResolvedValueOnce({ rows: [] } as never);
    const res = await detailGet(new NextRequest(`https://app.test/api/leads/${leadId}`, { headers: { ...headers, 'x-workspace-id': otherWid } }), ctx);
    expect(res.status).toBe(404);
  });
});
