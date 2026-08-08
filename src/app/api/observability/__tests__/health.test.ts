import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/db', () => ({
  query: vi.fn(),
  identityTransaction: vi.fn(async (_userId: string, operation: (client: { query: typeof query }) => unknown) => operation({ query })),
  tenantTransaction: vi.fn(async (_userId: string, operation: (client: { query: typeof query }) => unknown) => operation({ query })),
  default: { connect: vi.fn() },
}));

import { query } from '@/lib/db';
import { GET } from '../health/route';

const db = vi.mocked(query);

const wid = '11111111-1111-4111-8111-111111111111';
const headers = { cookie: `session=${'a'.repeat(64)}`, 'x-workspace-id': wid };
const req = () => new NextRequest('https://app.test/api/observability/health', { headers });

const session = () => db.mockResolvedValueOnce({ rows: [{ user_id: 'user-1', email: 'u@test.dev' }] } as never);
const member = (role = 'support_operator') => db.mockResolvedValueOnce({ rows: [{ role }] } as never);

beforeEach(() => db.mockReset());

describe('GET /api/observability/health', () => {
  it('requires authentication', async () => {
    db.mockResolvedValueOnce({ rows: [] } as never);
    const res = await GET(req());
    expect(res.status).toBe(401);
  });

  it('reports null age and zero backlog when nothing is waiting', async () => {
    session();
    member();
    db.mockResolvedValueOnce({ rows: [{ backlog: 0, oldest: null }] } as never); // inbound
    db.mockResolvedValueOnce({ rows: [{ backlog: 0, oldest: null }] } as never); // outbound

    const res = await GET(req());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.inbound).toEqual({ queue: 'inbound_events', backlogCount: 0, oldestUnclaimedAgeMs: null });
    expect(body.outbound).toEqual({ queue: 'outbound_jobs', backlogCount: 0, oldestUnclaimedAgeMs: null });
  });

  it('computes a positive age in ms when a backlog exists, scoped to the caller workspace', async () => {
    session();
    member();
    const oldest = new Date(Date.now() - 60_000).toISOString();
    db.mockResolvedValueOnce({ rows: [{ backlog: 2, oldest }] } as never);
    db.mockResolvedValueOnce({ rows: [{ backlog: 0, oldest: null }] } as never);

    const res = await GET(req());
    const body = await res.json();

    expect(body.inbound.backlogCount).toBe(2);
    expect(body.inbound.oldestUnclaimedAgeMs).toBeGreaterThanOrEqual(60_000);

    for (const call of db.mock.calls.slice(-2)) {
      expect(call[1]).toEqual([wid]);
    }
  });
});
