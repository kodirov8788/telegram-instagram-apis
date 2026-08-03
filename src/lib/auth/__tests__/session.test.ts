import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';

vi.mock('@/lib/db', () => ({ query: vi.fn() }));
import { query } from '@/lib/db';
import { authenticate, authorize } from '../session';

const db = vi.mocked(query);
const token = 'a'.repeat(64);
const request = (cookie = token, workspace = '11111111-1111-4111-8111-111111111111') =>
  new NextRequest('https://app.test/api/conversations', { headers: { cookie: `session=${cookie}`, 'x-workspace-id': workspace } });

beforeEach(() => db.mockReset());

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
