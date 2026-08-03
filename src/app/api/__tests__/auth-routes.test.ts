import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
vi.mock('@/lib/db', () => ({ query: vi.fn() }));
import { query } from '@/lib/db';
import { POST as login } from '../auth/login/route';
import { GET as me } from '../auth/me/route';
import { POST as logout } from '../auth/logout/route';
const db = vi.mocked(query);
beforeEach(() => db.mockReset());

describe('authentication routes', () => {
  it('uses a generic 401 for an unknown login', async () => {
    db.mockResolvedValueOnce({ rows: [] } as never);
    const res = await login(new NextRequest('https://app.test/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'nobody@test.dev', password: 'password123' }) }));
    expect(res.status).toBe(401); expect(await res.json()).toEqual({ error: 'Invalid email or password' });
  });
  it('current session rejects tampering', async () => {
    db.mockResolvedValueOnce({ rows: [] } as never);
    expect((await me(new NextRequest('https://app.test/api/auth/me', { headers: { cookie: 'session=tampered' } }))).status).toBe(401);
  });
  it('logout clears the secure http-only cookie', async () => {
    db.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const res = await logout(new NextRequest('https://app.test/api/auth/logout', { method: 'POST', headers: { cookie: `session=${'a'.repeat(64)}` } }));
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toContain('HttpOnly'); expect(cookie).toContain('Secure'); expect(cookie).toContain('SameSite=lax'); expect(cookie).toContain('Max-Age=0');
  });
});
