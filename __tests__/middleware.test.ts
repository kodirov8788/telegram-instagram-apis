import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const supabaseMocks = vi.hoisted(() => ({ getUser: vi.fn() }));

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: () => ({ auth: { getUser: supabaseMocks.getUser } }),
}));

import { middleware } from '../src/middleware';

const originalFetch = global.fetch;

function req(path: string) {
  return new NextRequest(new URL(path, 'https://app.test'));
}

function mockWorkspacesResponse(status: number, body?: unknown) {
  global.fetch = vi.fn(async () =>
    new Response(body ? JSON.stringify(body) : null, { status })
  ) as typeof fetch;
}

beforeEach(() => {
  supabaseMocks.getUser.mockReset();
  supabaseMocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe('middleware — unauthenticated', () => {
  it('allows /login through unauthenticated', async () => {
    mockWorkspacesResponse(401);
    const res = await middleware(req('/login'));
    expect(res.status).not.toBe(307);
    expect(res.headers.get('location')).toBeNull();
  });

  it('allows /signup through unauthenticated', async () => {
    mockWorkspacesResponse(401);
    const res = await middleware(req('/signup'));
    expect(res.headers.get('location')).toBeNull();
  });

  it('redirects a protected route to /login, preserving the intended path', async () => {
    mockWorkspacesResponse(401);
    const res = await middleware(req('/inbox'));
    const location = res.headers.get('location');
    expect(location).toContain('/login');
    expect(location).toContain('redirect=%2Finbox');
  });
});

describe('middleware — authenticated', () => {
  it('redirects /login to /inbox when the user already has a workspace', async () => {
    mockWorkspacesResponse(200, { workspaces: [{ id: 'w1', name: 'Acme', role: 'owner' }] });
    const res = await middleware(req('/login'));
    expect(res.headers.get('location')).toContain('/inbox');
  });

  it('redirects /signup to /onboarding when the user has zero workspaces', async () => {
    mockWorkspacesResponse(200, { workspaces: [] });
    const res = await middleware(req('/signup'));
    expect(res.headers.get('location')).toContain('/onboarding');
  });

  it('redirects a protected route to /onboarding when the user has zero workspaces', async () => {
    mockWorkspacesResponse(200, { workspaces: [] });
    const res = await middleware(req('/inbox'));
    expect(res.headers.get('location')).toContain('/onboarding');
  });

  it('does NOT redirect away from /onboarding even with zero workspaces', async () => {
    mockWorkspacesResponse(200, { workspaces: [] });
    const res = await middleware(req('/onboarding'));
    expect(res.headers.get('location')).toBeNull();
  });

  it('passes a protected route through when the user has a workspace', async () => {
    mockWorkspacesResponse(200, { workspaces: [{ id: 'w1', name: 'Acme', role: 'owner' }] });
    const res = await middleware(req('/inbox'));
    expect(res.headers.get('location')).toBeNull();
  });
});

describe('middleware — API and infra paths', () => {
  it('never gates /api/* routes', async () => {
    // No workspaces fetch should even be needed for API paths — confirm no
    // redirect regardless of auth state.
    mockWorkspacesResponse(401);
    const res = await middleware(req('/api/conversations'));
    expect(res.headers.get('location')).toBeNull();
  });

  it('fails open (passes through) if the internal /api/workspaces call itself errors', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('network hiccup');
    }) as unknown as typeof fetch;
    const res = await middleware(req('/inbox'));
    expect(res.headers.get('location')).toBeNull();
  });

  it('fails open (passes through, does not redirect) on an unexpected non-401/non-ok status from /api/workspaces', async () => {
    // Regression test: previously an unhandled status (e.g. 500) left
    // workspaceCount as `null`, which is neither 0 nor a real count, so
    // the zero-workspace redirect check (`workspaceCount === 0`) silently
    // never fired and the request fell through as if everything were fine
    // — an ambiguous state, not an explicit decision either way.
    mockWorkspacesResponse(500);
    const res = await middleware(req('/inbox'));
    expect(res.headers.get('location')).toBeNull();
  });
});

describe('middleware — cache-control', () => {
  it('sets no-store Cache-Control on a pass-through response', async () => {
    mockWorkspacesResponse(200, { workspaces: [{ id: 'w1', name: 'Acme', role: 'owner' }] });
    const res = await middleware(req('/inbox'));
    expect(res.headers.get('cache-control')).toContain('no-store');
  });

  it('sets no-store Cache-Control on a redirect response', async () => {
    mockWorkspacesResponse(401);
    const res = await middleware(req('/inbox'));
    expect(res.headers.get('cache-control')).toContain('no-store');
  });
});
