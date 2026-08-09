import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';

vi.mock('@/lib/db', () => ({ query: vi.fn() }));

const supabaseMocks = vi.hoisted(() => ({ getUser: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: () => ({ auth: { getUser: supabaseMocks.getUser } }),
}));

import { query } from '@/lib/db';
import { authenticate, authorize } from '../session';

const db = vi.mocked(query);
const token = 'a'.repeat(64);
const request = (cookie = token, workspace = '11111111-1111-4111-8111-111111111111') =>
  new NextRequest('https://app.test/api/conversations', { headers: { cookie: `session=${cookie}`, 'x-workspace-id': workspace } });

beforeEach(() => {
  db.mockReset();
  supabaseMocks.getUser.mockReset();
  // No Supabase session by default — existing tests exercise the legacy cookie path unmodified.
  supabaseMocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';
});

describe('session authentication', () => {
  it('rejects a missing session', async () => {
    await expect(authenticate(new NextRequest('https://app.test/api'))).rejects.toMatchObject({ status: 401 });
  });

  it('rejects a tampered session without querying by raw token', async () => {
    db.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    await expect(authenticate(request('tampered'))).rejects.toMatchObject({ status: 401 });
    expect(db.mock.calls[0][1]).toEqual([createHash('sha256').update('tampered').digest('hex')]);
  });

  it('rejects expired sessions', async () => {
    db.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    await expect(authenticate(request())).rejects.toMatchObject({ status: 401 });
  });

  it('revalidates current membership and role for every authorization', async () => {
    db.mockResolvedValueOnce({ rows: [{ user_id: 'u1', email: 'u@test.dev' }] } as never);
    db.mockResolvedValueOnce({ rows: [{ role: 'sales_manager' }] } as never);
    await expect(authorize(request(), 'conversation:update')).resolves.toMatchObject({ userId: 'u1', role: 'sales_manager' });
    db.mockResolvedValueOnce({ rows: [{ user_id: 'u1', email: 'u@test.dev' }] } as never);
    db.mockResolvedValueOnce({ rows: [] } as never);
    await expect(authorize(request(), 'conversation:update')).rejects.toMatchObject({ status: 403 });
  });

  it('applies a live demotion rather than a stale session role', async () => {
    db.mockResolvedValueOnce({ rows: [{ user_id: 'u1', email: 'u@test.dev' }] } as never);
    db.mockResolvedValueOnce({ rows: [{ role: 'read_only_analyst' }] } as never);
    await expect(authorize(request(), 'conversation:update')).rejects.toMatchObject({ status: 403 });
  });
});

describe('Supabase-backed authentication', () => {
  it('resolves the principal from a valid Supabase session without touching the legacy table', async () => {
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

  it('falls back to the legacy cookie session when Supabase has no session', async () => {
    supabaseMocks.getUser.mockResolvedValueOnce({ data: { user: null }, error: null });
    db.mockResolvedValueOnce({ rows: [{ user_id: 'legacy-1', email: 'legacy@test.dev' }] } as never);
    await expect(authenticate(request())).resolves.toEqual({ userId: 'legacy-1', email: 'legacy@test.dev' });
  });

  it('falls back to the legacy cookie session when Supabase returns an error', async () => {
    supabaseMocks.getUser.mockResolvedValueOnce({ data: { user: null }, error: new Error('invalid token') });
    db.mockResolvedValueOnce({ rows: [{ user_id: 'legacy-2', email: 'legacy2@test.dev' }] } as never);
    await expect(authenticate(request())).resolves.toEqual({ userId: 'legacy-2', email: 'legacy2@test.dev' });
  });

  it('rejects when neither Supabase nor the legacy cookie resolves a session', async () => {
    supabaseMocks.getUser.mockResolvedValueOnce({ data: { user: null }, error: null });
    await expect(authenticate(new NextRequest('https://app.test/api'))).rejects.toMatchObject({ status: 401 });
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
});
