import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/db', () => ({
  query: vi.fn(),
  identityTransaction: vi.fn(async (_userId: string, operation: (client: { query: typeof query }) => unknown) => operation({ query })),
  tenantTransaction: vi.fn(async (_userId: string, operation: (client: { query: typeof query }) => unknown) => operation({ query })),
  default: { connect: vi.fn() },
}));

import { query } from '@/lib/db';
import { GET } from '../route';

const db = vi.mocked(query);

const wid = '11111111-1111-4111-8111-111111111111';
const headers = { cookie: `session=${'a'.repeat(64)}`, 'x-workspace-id': wid };
const req = (url: string) => new NextRequest(url, { headers });

const session = () => db.mockResolvedValueOnce({ rows: [{ user_id: 'user-1', email: 'u@test.dev' }] } as never);
const member = (role = 'support_operator') => db.mockResolvedValueOnce({ rows: [{ role }] } as never);

beforeEach(() => db.mockReset());

describe('GET /api/provider-events', () => {
  it('requires authentication', async () => {
    db.mockResolvedValueOnce({ rows: [] } as never);
    const res = await GET(req('https://app.test/api/provider-events'));
    expect(res.status).toBe(401);
  });

  it('requires a role with conversation:read', async () => {
    session();
    db.mockResolvedValueOnce({ rows: [] } as never);
    const res = await GET(req('https://app.test/api/provider-events'));
    expect(res.status).toBe(403);
  });

  it('defaults to permanent_failed, scoped to the caller workspace', async () => {
    session();
    member();
    db.mockResolvedValueOnce({ rows: [{ id: 'evt-1', status: 'permanent_failed' }] } as never);

    const res = await GET(req('https://app.test/api/provider-events'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.events).toEqual([{ id: 'evt-1', status: 'permanent_failed' }]);
    const [sql, params] = db.mock.calls[db.mock.calls.length - 1];
    expect(sql).toContain('FROM provider_events');
    expect(sql).not.toContain('payload');
    expect(params).toEqual([wid, ['permanent_failed']]);
  });

  it('accepts an explicit status filter', async () => {
    session();
    member();
    db.mockResolvedValueOnce({ rows: [] } as never);
    await GET(req('https://app.test/api/provider-events?status=retryable_failed,processing'));
    const [, params] = db.mock.calls[db.mock.calls.length - 1];
    expect(params).toEqual([wid, ['retryable_failed', 'processing']]);
  });

  it('rejects an invalid status value', async () => {
    session();
    member();
    const res = await GET(req('https://app.test/api/provider-events?status=bogus'));
    expect(res.status).toBe(400);
  });
});
