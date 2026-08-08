import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/db', () => ({
  query: vi.fn(),
  tenantTransaction: vi.fn(async (_userId: string, operation: (client: { query: typeof query }) => unknown) => operation({ query })),
  default: { connect: vi.fn() },
}));
import { query } from '@/lib/db';
import { GET as leadsGet } from '../leads/route';

const db = vi.mocked(query);
const wid = '11111111-1111-4111-8111-111111111111';
const headers = { cookie: `session=${'a'.repeat(64)}`, 'x-workspace-id': wid };

beforeEach(() => { db.mockReset(); });

const session = () => db.mockResolvedValueOnce({ rows: [{ user_id: 'user-1', email: 'u@test.dev' }] } as never);
const member = (role: string) => db.mockResolvedValueOnce({ rows: [{ role }] } as never);

describe('GET /api/leads', () => {
  it('requires authentication', async () => {
    db.mockResolvedValueOnce({ rows: [] } as never);
    const res = await leadsGet(new NextRequest('https://app.test/api/leads', { headers: { 'x-workspace-id': wid } }));
    expect(res.status).toBe(401);
  });

  it('rejects roles without leads:read', async () => {
    session(); member('support_operator');
    const res = await leadsGet(new NextRequest('https://app.test/api/leads', { headers }));
    expect(res.status).toBe(403);
  });

  it('scopes the list to the authorized tenant and returns rows', async () => {
    session(); member('sales_manager');
    db.mockResolvedValueOnce({ rows: [{ id: 'lead-1', workspace_id: wid, status: 'qualified', score: 70 }] } as never);
    const res = await leadsGet(new NextRequest('https://app.test/api/leads', { headers }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.leads).toEqual([{ id: 'lead-1', workspace_id: wid, status: 'qualified', score: 70 }]);
    expect(db.mock.calls[2][1]).toEqual([wid]);
  });

  it('filters by status when provided', async () => {
    session(); member('owner');
    db.mockResolvedValueOnce({ rows: [] } as never);
    const res = await leadsGet(new NextRequest('https://app.test/api/leads?status=qualified', { headers }));
    expect(res.status).toBe(200);
    expect(db.mock.calls[2][0]).toContain('l.status = $2');
    expect(db.mock.calls[2][1]).toEqual([wid, 'qualified']);
  });

  it('rejects an invalid status filter', async () => {
    session(); member('owner');
    const res = await leadsGet(new NextRequest('https://app.test/api/leads?status=bogus', { headers }));
    expect(res.status).toBe(400);
  });
});
