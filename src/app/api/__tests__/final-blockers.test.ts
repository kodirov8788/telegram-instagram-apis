import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ query: vi.fn(), tenantTransaction: vi.fn() }));
vi.mock('@/lib/db', () => ({ query: mocks.query, tenantTransaction: mocks.tenantTransaction, default: { connect: vi.fn() } }));
vi.mock('@/lib/supabase/server', async () => {
  const m = await import('@/lib/auth/__tests__/supabase-session-mock');
  return { createSupabaseServerClient: m.mockCreateSupabaseServerClient };
});
import { withLiveAuthorization } from '@/lib/auth/session';
import { setMockSupabaseUser } from '@/lib/auth/__tests__/supabase-session-mock';
const { query, tenantTransaction } = mocks;

const wid = '11111111-1111-4111-8111-111111111111';
const uid = '22222222-2222-4222-8222-222222222222';
const request = () => new NextRequest('https://app.test/api/conversations', {
  headers: { 'x-workspace-id': wid },
});

beforeEach(() => { query.mockReset(); tenantTransaction.mockReset(); setMockSupabaseUser({ id: uid, email: 'u@test.dev' }); });

describe('atomic live authorization', () => {
  it('locks and authorizes membership inside the same tenant transaction as the operation', async () => {
    const client = { query: vi.fn().mockResolvedValueOnce({ rows: [{ role: 'admin' }] }) };
    tenantTransaction.mockImplementationOnce(async (_uid: string, fn: (c: typeof client) => unknown) => fn(client));
    const callback = vi.fn(async () => 'ok');

    await expect(withLiveAuthorization(request(), 'workspace:update', callback)).resolves.toBe('ok');
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('FOR SHARE'), [wid, uid]);
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: wid, userId: uid, role: 'admin' }), client);
  });

  it('fails closed before invoking the operation after a live demotion', async () => {
    const client = { query: vi.fn().mockResolvedValueOnce({ rows: [{ role: 'support_operator' }] }) };
    tenantTransaction.mockImplementationOnce(async (_uid: string, fn: (c: typeof client) => unknown) => fn(client));
    const callback = vi.fn();

    await expect(withLiveAuthorization(request(), 'workspace:update', callback)).rejects.toMatchObject({ status: 403 });
    expect(callback).not.toHaveBeenCalled();
  });
});
