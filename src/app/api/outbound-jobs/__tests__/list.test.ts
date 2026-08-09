import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/db', () => ({
  query: vi.fn(),
  identityTransaction: vi.fn(async (_userId: string, operation: (client: { query: typeof query }) => unknown) => operation({ query })),
  tenantTransaction: vi.fn(async (_userId: string, operation: (client: { query: typeof query }) => unknown) => operation({ query })),
  default: { connect: vi.fn() },
}));
vi.mock('@/lib/supabase/server', async () => {
  const m = await import('@/lib/auth/__tests__/supabase-session-mock');
  return { createSupabaseServerClient: m.mockCreateSupabaseServerClient };
});

import { query } from '@/lib/db';
import { GET } from '../route';
import { setMockSupabaseUser } from '@/lib/auth/__tests__/supabase-session-mock';

const db = vi.mocked(query);

const wid = '11111111-1111-4111-8111-111111111111';
const otherWid = '99999999-9999-4999-8999-999999999999';
const headers = { 'x-workspace-id': wid };
const req = (url: string) => new NextRequest(url, { headers });

const member = (role = 'support_operator') => db.mockResolvedValueOnce({ rows: [{ role }] } as never);

beforeEach(() => { db.mockReset(); setMockSupabaseUser({ id: 'user-1', email: 'u@test.dev' }); });

describe('GET /api/outbound-jobs', () => {
  it('requires authentication', async () => {
    setMockSupabaseUser(null);
    const res = await GET(req('https://app.test/api/outbound-jobs'));
    expect(res.status).toBe(401);
  });

  it('requires a role with conversation:read', async () => {
    db.mockResolvedValueOnce({ rows: [] } as never); // no membership row
    const res = await GET(req('https://app.test/api/outbound-jobs'));
    expect(res.status).toBe(403);
  });

  it('defaults to permanent_failed + ambiguous and scopes to the caller workspace', async () => {
    member();
    db.mockResolvedValueOnce({ rows: [{ id: 'job-1', status: 'ambiguous' }] } as never);

    const res = await GET(req('https://app.test/api/outbound-jobs'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.jobs).toEqual([{ id: 'job-1', status: 'ambiguous' }]);
    const [sql, params] = db.mock.calls[db.mock.calls.length - 1];
    expect(sql).toContain('FROM outbound_jobs');
    expect(sql).toContain('workspace_id = $1');
    expect(params).toEqual([wid, ['permanent_failed', 'ambiguous']]);
  });

  it('accepts an explicit comma-separated status filter', async () => {
    member();
    db.mockResolvedValueOnce({ rows: [] } as never);

    await GET(req('https://app.test/api/outbound-jobs?status=sent,pending'));

    const [, params] = db.mock.calls[db.mock.calls.length - 1];
    expect(params).toEqual([wid, ['sent', 'pending']]);
  });

  it('rejects an invalid status value', async () => {
    member();
    const res = await GET(req('https://app.test/api/outbound-jobs?status=not_a_status'));
    expect(res.status).toBe(400);
  });

  it('never lets a caller read another workspace\'s jobs via query params', async () => {
    member();
    db.mockResolvedValueOnce({ rows: [] } as never);
    await GET(req(`https://app.test/api/outbound-jobs?workspace_id=${otherWid}`));
    // x-workspace-id header wins per selectedWorkspace(); the param filter is workspace_id from the header-derived principal only.
    const [, params] = db.mock.calls[db.mock.calls.length - 1] as [string, unknown[]];
    expect(params[0]).toBe(wid);
  });
});
