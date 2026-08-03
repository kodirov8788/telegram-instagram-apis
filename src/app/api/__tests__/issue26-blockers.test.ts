import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const client = { query: vi.fn(), release: vi.fn() };
vi.mock('@/lib/db', () => ({
  query: vi.fn(),
  identityTransaction: vi.fn(),
  tenantTransaction: vi.fn(),
  default: { connect: vi.fn(async () => client) },
}));
vi.mock('bcryptjs', () => ({ hash: vi.fn(async () => 'hashed') }));
import pool, { identityTransaction, query, tenantTransaction } from '@/lib/db';
import { POST as register } from '../auth/register/route';
import { POST as invite } from '../workspace/invitations/route';
import { POST as accept } from '../invitations/accept/route';
import { GET as exportLeads } from '../leads/export/route';

const db = vi.mocked(query);
const identity = vi.mocked(identityTransaction);
const tenant = vi.mocked(tenantTransaction);
const wid = '11111111-1111-4111-8111-111111111111';
const uid = '22222222-2222-4222-8222-222222222222';
const headers = { cookie: `session=${'a'.repeat(64)}`, 'x-workspace-id': wid, 'content-type': 'application/json' };
const request = (url: string, body?: object) => new NextRequest(url, { method: body ? 'POST' : 'GET', headers, ...(body ? { body: JSON.stringify(body) } : {}) });

beforeEach(() => { vi.clearAllMocks(); db.mockReset(); identity.mockReset(); tenant.mockReset(); client.query.mockReset(); });

describe('registration atomicity', () => {
  it('commits user and session in the same transaction', async () => {
    client.query.mockResolvedValueOnce({}).mockResolvedValueOnce({ rows: [{ id: uid, email: 'new@test.dev', full_name: 'New' }] }).mockResolvedValueOnce({}).mockResolvedValueOnce({});
    const res = await register(request('https://app.test/api/auth/register', { email: 'new@test.dev', fullName: 'New', password: 'long-password' }));
    expect(res.status).toBe(201);
    expect(client.query.mock.calls.map(c => c[0])).toEqual(['BEGIN', expect.stringContaining('INSERT INTO users'), expect.stringContaining('INSERT INTO user_sessions'), 'COMMIT']);
  });
  it('rolls back a duplicate registration', async () => {
    client.query.mockResolvedValueOnce({}).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({});
    expect((await register(request('https://app.test/api/auth/register', { email: 'new@test.dev', fullName: 'New', password: 'long-password' }))).status).toBe(409);
    expect(client.query).toHaveBeenLastCalledWith('ROLLBACK');
  });
  it('rolls back the user when session insertion fails', async () => {
    client.query.mockResolvedValueOnce({}).mockResolvedValueOnce({ rows: [{ id: uid, email: 'new@test.dev' }] }).mockRejectedValueOnce(new Error('session failed')).mockResolvedValueOnce({});
    expect((await register(request('https://app.test/api/auth/register', { email: 'new@test.dev', fullName: 'New', password: 'long-password' }))).status).toBe(500);
    expect(client.query).toHaveBeenLastCalledWith('ROLLBACK');
  });
});

describe('invitation safety', () => {
  const authenticated = () => db.mockResolvedValueOnce({ rows: [{ user_id: uid, email: 'user@test.dev' }] } as never).mockResolvedValueOnce({ rows: [{ role: 'owner' }] } as never);
  it('creates through the tenant transaction and rejects an existing member atomically', async () => {
    authenticated(); tenant.mockRejectedValueOnce(Object.assign(new Error('member'), { code: '23505' }));
    const res = await invite(request('https://app.test/api/workspace/invitations', { email: 'MEMBER@test.dev', role: 'admin' }));
    expect(res.status).toBe(409);
    expect(tenant).toHaveBeenCalled();
  });
  it('acceptance is insert-only and returns a generic error on existing membership', async () => {
    db.mockResolvedValueOnce({ rows: [{ user_id: uid, email: 'user@test.dev' }] } as never);
    identity.mockImplementationOnce(async (_userId, operation) => operation(client as never));
    client.query.mockResolvedValueOnce({ rows: [] });
    const res = await accept(request('https://app.test/api/invitations/accept', { token: 'b'.repeat(64) }));
    expect(res.status).toBe(404);
    expect(identity).toHaveBeenCalledWith(uid, expect.any(Function));
    expect(client.query).toHaveBeenCalledWith('SELECT * FROM accept_workspace_invitation($1)', [expect.any(String)]);
    expect(client.query.mock.calls.some(c => String(c[0]).includes('DO UPDATE'))).toBe(false);
  });
});

describe('CSV formula defense', () => {
  it.each(['=x', '+x', '-x', '@x', '\tx', '\rx', '\nx', ' \n\t=x', '\u0000  +x'])('neutralizes %j after all leading controls/whitespace', async value => {
    db.mockResolvedValueOnce({ rows: [{ user_id: uid, email: 'user@test.dev' }] } as never);
    tenant.mockImplementationOnce(async (_u, fn) => {
      const clientQuery = vi.fn()
        .mockResolvedValueOnce({ rows: [{ role: 'read_only_analyst' }] })
        .mockResolvedValueOnce({ rows: [{ id: '1', full_name: value }] });
      return fn({ query: clientQuery } as never);
    });
    const text = await (await exportLeads(request(`https://app.test/api/leads/export?workspace_id=${wid}`))).text();
    expect(text).toContain(`'${value}`);
  });
});
