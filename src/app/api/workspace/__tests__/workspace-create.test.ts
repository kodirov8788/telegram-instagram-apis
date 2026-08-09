import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/session')>();
  return { ...actual, authenticate: vi.fn() };
});

const dbClientMocks = vi.hoisted(() => ({ query: vi.fn(), connect: vi.fn() }));
vi.mock('@/lib/db', () => ({
  default: { connect: dbClientMocks.connect },
  query: dbClientMocks.query,
  identityTransaction: vi.fn(async (_userId: string, operation: (client: { query: typeof dbClientMocks.query }) => unknown) =>
    operation({ query: dbClientMocks.query })
  ),
}));

import { authenticate } from '@/lib/auth/session';
import { POST } from '../route';

const auth = vi.mocked(authenticate);
const dbQuery = dbClientMocks.query;

const principal = { userId: 'user-1', email: 'u@test.dev' };

function req(body: unknown) {
  return new NextRequest('https://app.test/api/workspace', {
    method: 'POST',
    headers: { cookie: `session=${'a'.repeat(64)}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  auth.mockReset();
  dbQuery.mockReset();
});

describe('POST /api/workspace — workspace creation', () => {
  it('requires authentication', async () => {
    auth.mockRejectedValueOnce(new Error('Authentication required'));
    const res = await POST(req({ name: 'Acme Inc.' }));
    // errorResponse maps unrecognized thrown errors to 500 unless HttpError —
    // authenticate() itself throws an HttpError(401) in the real
    // implementation; this test only asserts the route doesn't silently
    // create a workspace when authenticate() fails.
    expect(res.status).not.toBe(201);
  });

  it('rejects an empty workspace name', async () => {
    auth.mockResolvedValueOnce(principal);
    const res = await POST(req({ name: '' }));
    expect(res.status).toBe(400);
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it('creates a workspace for the authenticated user and returns 201', async () => {
    auth.mockResolvedValueOnce(principal);
    dbQuery.mockResolvedValueOnce({
      rows: [{ id: 'ws-1', name: 'Acme Inc.', industry: 'general', time_zone: 'Asia/Tashkent' }],
    } as never);

    const res = await POST(req({ name: 'Acme Inc.' }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.workspace).toEqual(
      expect.objectContaining({ id: 'ws-1', name: 'Acme Inc.' })
    );
    // bootstrap_workspace is called with the caller-supplied name
    expect(dbQuery).toHaveBeenCalledWith(expect.stringContaining('bootstrap_workspace'), expect.arrayContaining(['Acme Inc.']));
  });
});
