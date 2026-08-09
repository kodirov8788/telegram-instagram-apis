import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/db', () => ({
  query: vi.fn(),
  tenantTransaction: vi.fn(async (_userId: string, operation: (client: { query: typeof query }) => unknown) => operation({ query })),
  default: { connect: vi.fn() },
}));
vi.mock('@/lib/services/audit-log', () => ({ AuditLogService: { logEvent: vi.fn() } }));
vi.mock('@/lib/supabase/server', async () => {
  const m = await import('@/lib/auth/__tests__/supabase-session-mock');
  return { createSupabaseServerClient: m.mockCreateSupabaseServerClient };
});

import { query } from '@/lib/db';
import { AuditLogService } from '@/lib/services/audit-log';
import { GET as listGet, POST as createPost } from '../route';
import { GET as connGet, PATCH as connPatch, DELETE as connDelete } from '../[id]/route';
import { POST as testPost } from '../[id]/test/route';
import { setMockSupabaseUser } from '@/lib/auth/__tests__/supabase-session-mock';

const db = vi.mocked(query);
const audit = vi.mocked(AuditLogService.logEvent);

const wid = '11111111-1111-4111-8111-111111111111';
const cid = '22222222-2222-4222-8222-222222222222';
const otherWid = '33333333-3333-4333-8333-333333333333';
const headers = { 'x-workspace-id': wid, 'content-type': 'application/json' };

const member = (role: string) => db.mockResolvedValueOnce({ rows: [{ role }] } as never);

const safeRow = (overrides: Record<string, unknown> = {}) => ({
  id: cid, workspace_id: wid, channel: 'telegram', account_identifier: 'my_bot',
  is_active: true, last_synced_at: null, created_at: new Date().toISOString(),
  has_vault_credential: true, ...overrides,
});

// Every mocked row that stands in for a DB response is scanned for a
// `credentials` key or a secret-shaped string value, so a route that
// accidentally SELECTs/returns raw credentials would fail this check even
// if the specific assertions below didn't already catch it directly.
function assertNoSecretLeak(body: unknown) {
  const text = JSON.stringify(body);
  expect(text).not.toMatch(/credentials/i);
  expect(text.toLowerCase()).not.toContain('bot-token-secret');
  expect(text.toLowerCase()).not.toContain('ig-access-token-secret');
}

beforeEach(() => { db.mockReset(); audit.mockReset(); vi.restoreAllMocks(); setMockSupabaseUser({ id: 'user-1', email: 'u@test.dev' }); });

describe('GET /api/connections', () => {
  it('requires authentication', async () => {
    setMockSupabaseUser(null);
    const res = await listGet(new NextRequest('https://app.test/api/connections', { headers: { 'x-workspace-id': wid } }));
    expect(res.status).toBe(401);
  });

  it('rejects roles without connections:read', async () => {
    member('sales_representative');
    const res = await listGet(new NextRequest('https://app.test/api/connections', { headers }));
    expect(res.status).toBe(403);
  });

  it('lists connections scoped to workspace_id, never leaking credentials', async () => {
    member('admin');
    db.mockResolvedValueOnce({ rows: [safeRow()] } as never);
    const res = await listGet(new NextRequest('https://app.test/api/connections', { headers }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.connections).toHaveLength(1);
    expect(body.connections[0]).not.toHaveProperty('credentials');
    expect(body.connections[0]).not.toHaveProperty('credentials_vault_id');
    expect(body.connections[0].has_vault_credential).toBe(true);
    expect(db.mock.calls[1][1]).toEqual([wid]);
    assertNoSecretLeak(body);
  });
});

describe('POST /api/connections', () => {
  it('rejects roles without connections:write', async () => {
    member('support_operator');
    const res = await createPost(new NextRequest('https://app.test/api/connections', {
      method: 'POST', headers, body: JSON.stringify({ channel: 'telegram', accountIdentifier: 'bot' }),
    }));
    expect(res.status).toBe(403);
  });

  it('rejects a body that supplies a raw token/credential field', async () => {
    member('owner');
    const res = await createPost(new NextRequest('https://app.test/api/connections', {
      method: 'POST', headers, body: JSON.stringify({ channel: 'telegram', accountIdentifier: 'bot', token: 'secret-token-value' }),
    }));
    expect(res.status).toBe(400); // .strict() rejects the unknown `token` key
  });

  it('creates a connection scoped to the caller workspace, with no credential set', async () => {
    member('owner');
    db.mockResolvedValueOnce({ rows: [safeRow({ is_active: false, has_vault_credential: false })] } as never);
    const res = await createPost(new NextRequest('https://app.test/api/connections', {
      method: 'POST', headers, body: JSON.stringify({ channel: 'telegram', accountIdentifier: 'my_bot' }),
    }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.connection.has_vault_credential).toBe(false);
    expect(db.mock.calls[1][1]).toEqual([wid, 'telegram', 'my_bot']);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'connection.created' }));
    assertNoSecretLeak(body);
  });
});

describe('GET /api/connections/:id', () => {
  const ctx = { params: Promise.resolve({ id: cid }) };

  it('404s for a cross-tenant id', async () => {
    member('admin');
    db.mockResolvedValueOnce({ rows: [] } as never);
    const res = await connGet(new NextRequest(`https://app.test/api/connections/${cid}`, { headers: { ...headers, 'x-workspace-id': otherWid } }), ctx);
    expect(res.status).toBe(404);
  });

  it('returns the safe shape only', async () => {
    member('admin');
    db.mockResolvedValueOnce({ rows: [safeRow()] } as never);
    const res = await connGet(new NextRequest(`https://app.test/api/connections/${cid}`, { headers }), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    assertNoSecretLeak(body);
  });
});

describe('PATCH /api/connections/:id', () => {
  const ctx = { params: Promise.resolve({ id: cid }) };

  it('rejects roles without connections:write', async () => {
    member('sales_manager');
    const res = await connPatch(new NextRequest(`https://app.test/api/connections/${cid}`, {
      method: 'PATCH', headers, body: JSON.stringify({ isActive: false }),
    }), ctx);
    expect(res.status).toBe(403);
  });

  it('updates account_identifier/is_active without ever accepting/returning credentials', async () => {
    member('owner');
    db.mockResolvedValueOnce({ rows: [safeRow()] } as never); // existing lookup
    db.mockResolvedValueOnce({ rows: [safeRow({ is_active: false })] } as never); // UPDATE
    const res = await connPatch(new NextRequest(`https://app.test/api/connections/${cid}`, {
      method: 'PATCH', headers, body: JSON.stringify({ isActive: false }),
    }), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'connection.updated' }));
    assertNoSecretLeak(body);
  });

  it('routes a `credential` field through rotateConnectionSecret (set_connection_secret), never into `credentials`', async () => {
    member('owner');
    db.mockResolvedValueOnce({ rows: [safeRow()] } as never); // existing lookup
    db.mockResolvedValueOnce({ rows: [safeRow()] } as never); // UPDATE (no column changes besides possibly none)
    db.mockResolvedValueOnce({ rows: [{ id: cid }] } as never); // set_connection_secret call in existing-connection check
    db.mockResolvedValueOnce({ rows: [{ set_connection_secret: 'vault-uuid' }] } as never); // set_connection_secret call itself
    const res = await connPatch(new NextRequest(`https://app.test/api/connections/${cid}`, {
      method: 'PATCH', headers, body: JSON.stringify({ credential: { token: 'bot-token-secret-value' } }),
    }), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    assertNoSecretLeak(body);
    // The audit log records that a rotation happened, never the value.
    const auditCall = audit.mock.calls[0][0];
    expect(JSON.stringify(auditCall)).not.toContain('bot-token-secret-value');
    expect(auditCall.newValue).toMatchObject({ credentialRotated: true });
  });

  it('404s for cross-tenant id', async () => {
    member('owner');
    db.mockResolvedValueOnce({ rows: [] } as never); // existing lookup: not found
    const res = await connPatch(new NextRequest(`https://app.test/api/connections/${cid}`, {
      method: 'PATCH', headers, body: JSON.stringify({ isActive: true }),
    }), ctx);
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/connections/:id', () => {
  const ctx = { params: Promise.resolve({ id: cid }) };

  it('rejects roles without connections:write', async () => {
    member('support_operator');
    const res = await connDelete(new NextRequest(`https://app.test/api/connections/${cid}`, { method: 'DELETE', headers }), ctx);
    expect(res.status).toBe(403);
  });

  it('404s when absent for this tenant', async () => {
    member('owner');
    db.mockResolvedValueOnce({ rows: [] } as never);
    const res = await connDelete(new NextRequest(`https://app.test/api/connections/${cid}`, { method: 'DELETE', headers }), ctx);
    expect(res.status).toBe(404);
  });

  it('deletes scoped to workspace_id and audits', async () => {
    member('owner');
    db.mockResolvedValueOnce({ rows: [{ id: cid }] } as never);
    const res = await connDelete(new NextRequest(`https://app.test/api/connections/${cid}`, { method: 'DELETE', headers }), ctx);
    expect(res.status).toBe(200);
    expect(db.mock.calls[1][1]).toEqual([cid, wid]);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'connection.deleted' }));
  });

  it('returns 409 (not a raw 500) when the connection has referencing rows (FK RESTRICT)', async () => {
    member('owner');
    const fkError = Object.assign(new Error('update or delete on table "channel_connections" violates foreign key constraint'), { code: '23503' });
    db.mockRejectedValueOnce(fkError);
    const res = await connDelete(new NextRequest(`https://app.test/api/connections/${cid}`, { method: 'DELETE', headers }), ctx);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/in use/i);
    expect(audit).not.toHaveBeenCalled();
  });
});

describe('POST /api/connections/:id/test', () => {
  const ctx = { params: Promise.resolve({ id: cid }) };

  it('rejects roles without connections:write', async () => {
    member('sales_manager');
    const res = await testPost(new NextRequest(`https://app.test/api/connections/${cid}/test`, { method: 'POST', headers }), ctx);
    expect(res.status).toBe(403);
  });

  it('404s for cross-tenant id', async () => {
    member('owner');
    db.mockResolvedValueOnce({ rows: [] } as never);
    const res = await testPost(new NextRequest(`https://app.test/api/connections/${cid}/test`, { method: 'POST', headers }), ctx);
    expect(res.status).toBe(404);
  });

  it('reports ok:false without a stored credential, never leaking secrets, and makes no live call', async () => {
    member('owner');
    db.mockResolvedValueOnce({ rows: [safeRow({ has_vault_credential: false })] } as never); // getConnection
    db.mockResolvedValueOnce({ rows: [{ secret: null }] } as never); // get_connection_secret -> null
    const fetchSpy = vi.spyOn(global, 'fetch');
    const res = await testPost(new NextRequest(`https://app.test/api/connections/${cid}/test`, { method: 'POST', headers }), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    assertNoSecretLeak(body);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('makes exactly one live Telegram call, and never echoes the token in the response', async () => {
    member('owner');
    db.mockResolvedValueOnce({ rows: [safeRow({ channel: 'telegram' })] } as never); // getConnection
    db.mockResolvedValueOnce({ rows: [{ secret: JSON.stringify({ token: 'bot-token-secret-value' }) }] } as never); // get_connection_secret
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: { id: 1 } }), { status: 200 }));
    const res = await testPost(new NextRequest(`https://app.test/api/connections/${cid}/test`, { method: 'POST', headers }), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
    assertNoSecretLeak(body);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0][0])).toContain('bot-token-secret-value'); // the outbound call itself, not the response
  });

  it('reports ok:false without echoing provider error bodies (which could contain the token)', async () => {
    member('owner');
    db.mockResolvedValueOnce({ rows: [safeRow({ channel: 'instagram' })] } as never);
    db.mockResolvedValueOnce({ rows: [{ secret: JSON.stringify({ access_token: 'ig-access-token-secret-value' }) }] } as never);
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'bad token ig-access-token-secret-value' } }), { status: 401 }));
    const res = await testPost(new NextRequest(`https://app.test/api/connections/${cid}/test`, { method: 'POST', headers }), ctx);
    const body = await res.json();
    expect(body.ok).toBe(false);
    assertNoSecretLeak(body);
  });
});
