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
import { GET } from '../metrics/route';
import { setMockSupabaseUser } from '@/lib/auth/__tests__/supabase-session-mock';

const db = vi.mocked(query);

const wid = '11111111-1111-4111-8111-111111111111';
const headers = { 'x-workspace-id': wid };
const req = () => new NextRequest('https://app.test/api/observability/metrics', { headers });

const member = (role = 'support_operator') => db.mockResolvedValueOnce({ rows: [{ role }] } as never);

beforeEach(() => { db.mockReset(); setMockSupabaseUser({ id: 'user-1', email: 'u@test.dev' }); });

describe('GET /api/observability/metrics', () => {
  it('requires authentication', async () => {
    setMockSupabaseUser(null);
    const res = await GET(req());
    expect(res.status).toBe(401);
  });

  it('requires a role with conversation:read', async () => {
    db.mockResolvedValueOnce({ rows: [] } as never);
    const res = await GET(req());
    expect(res.status).toBe(403);
  });

  it('returns zero-filled counts per status, merged with actual DB counts, scoped to the caller workspace', async () => {
    member();
    db.mockResolvedValueOnce({ rows: [{ status: 'processed', count: 5 }, { status: 'retryable_failed', count: 1 }] } as never); // provider_events
    db.mockResolvedValueOnce({ rows: [{ status: 'sent', count: 3 }] } as never); // outbound_jobs

    const res = await GET(req());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.inbound).toEqual({
      received: 0, queued: 0, processing: 0, processed: 5, retryable_failed: 1, permanent_failed: 0,
    });
    expect(body.outbound).toEqual({
      pending: 0, processing: 0, sent: 3, retryable_failed: 0, permanent_failed: 0, ambiguous: 0,
    });

    for (const call of db.mock.calls.slice(-2)) {
      expect(call[1]).toEqual([wid]);
    }
  });
});
