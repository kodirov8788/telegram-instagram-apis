import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/db', () => ({ query: vi.fn() }));

const supabaseMocks = vi.hoisted(() => ({ getUser: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: () => ({ auth: { getUser: supabaseMocks.getUser } }),
}));

import { query } from '@/lib/db';
import { authenticate, authorize } from '../session';

const db = vi.mocked(query);
const request = (workspace = '11111111-1111-4111-8111-111111111111') =>
  new NextRequest('https://app.test/api/conversations', { headers: { 'x-workspace-id': workspace } });

beforeEach(() => {
  db.mockReset();
  supabaseMocks.getUser.mockReset();
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';
});

describe('Supabase-backed authentication', () => {
  it('rejects a request with no Supabase session', async () => {
    supabaseMocks.getUser.mockResolvedValueOnce({ data: { user: null }, error: null });
    await expect(authenticate(new NextRequest('https://app.test/api'))).rejects.toMatchObject({ status: 401 });
    expect(db).not.toHaveBeenCalled();
  });

  it('rejects when Supabase returns an error', async () => {
    supabaseMocks.getUser.mockResolvedValueOnce({ data: { user: null }, error: new Error('invalid token') });
    await expect(authenticate(new NextRequest('https://app.test/api'))).rejects.toMatchObject({ status: 401 });
  });

  it('resolves the principal from a valid Supabase session', async () => {
    supabaseMocks.getUser.mockResolvedValueOnce({
      data: { user: { id: 'sb-user-1', email: 'sb@test.dev' } },
      error: null,
    });
    await expect(authenticate(new NextRequest('https://app.test/api'))).resolves.toEqual({
      userId: 'sb-user-1',
      email: 'sb@test.dev',
    });
    expect(db).not.toHaveBeenCalled();
  });

  it('revalidates current membership and role for every authorization', async () => {
    supabaseMocks.getUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'u@test.dev' } }, error: null });
    db.mockResolvedValueOnce({ rows: [{ role: 'sales_manager' }] } as never);
    await expect(authorize(request(), 'conversation:update')).resolves.toMatchObject({ userId: 'u1', role: 'sales_manager' });
    db.mockResolvedValueOnce({ rows: [] } as never);
    await expect(authorize(request(), 'conversation:update')).rejects.toMatchObject({ status: 403 });
  });

  it('grants workspace authorization end-to-end from a Supabase session with the correct role', async () => {
    supabaseMocks.getUser.mockResolvedValueOnce({
      data: { user: { id: 'sb-user-2', email: 'sb2@test.dev' } },
      error: null,
    });
    db.mockResolvedValueOnce({ rows: [{ role: 'sales_manager' }] } as never);
    await expect(authorize(request(), 'conversation:update')).resolves.toMatchObject({
      userId: 'sb-user-2',
      role: 'sales_manager',
    });
  });

  it('denies workspace authorization from a Supabase session with the wrong role', async () => {
    supabaseMocks.getUser.mockResolvedValueOnce({
      data: { user: { id: 'sb-user-3', email: 'sb3@test.dev' } },
      error: null,
    });
    db.mockResolvedValueOnce({ rows: [{ role: 'read_only_analyst' }] } as never);
    await expect(authorize(request(), 'conversation:update')).rejects.toMatchObject({ status: 403 });
  });

  it('applies a live demotion rather than a stale role', async () => {
    supabaseMocks.getUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'u@test.dev' } }, error: null });
    db.mockResolvedValueOnce({ rows: [{ role: 'read_only_analyst' }] } as never);
    await expect(authorize(request(), 'conversation:update')).rejects.toMatchObject({ status: 403 });
  });
});
