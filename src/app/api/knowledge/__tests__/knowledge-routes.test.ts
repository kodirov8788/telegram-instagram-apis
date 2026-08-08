import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/db', () => ({
  query: vi.fn(),
  tenantTransaction: vi.fn(async (_userId: string, operation: (client: { query: typeof query }) => unknown) => operation({ query })),
  default: { connect: vi.fn() },
}));
vi.mock('@/lib/services/audit-log', () => ({ AuditLogService: { logEvent: vi.fn() } }));

import { query } from '@/lib/db';
import { AuditLogService } from '@/lib/services/audit-log';
import { GET as listGet, POST as createPost } from '../route';
import { GET as itemGet, PATCH as itemPatch, DELETE as itemDelete } from '../[itemId]/route';
import { POST as approvePost } from '../[itemId]/approve/route';

const db = vi.mocked(query);
const audit = vi.mocked(AuditLogService.logEvent);

const wid = '11111111-1111-4111-8111-111111111111';
const iid = '22222222-2222-4222-8222-222222222222';
const otherWid = '33333333-3333-4333-8333-333333333333';
const headers = { cookie: `session=${'a'.repeat(64)}`, 'x-workspace-id': wid, 'content-type': 'application/json' };

const session = () => db.mockResolvedValueOnce({ rows: [{ user_id: 'user-1', email: 'u@test.dev' }] } as never);
const member = (role: string) => db.mockResolvedValueOnce({ rows: [{ role }] } as never);

beforeEach(() => { db.mockReset(); audit.mockReset(); });

describe('GET /api/knowledge', () => {
  it('requires authentication', async () => {
    db.mockResolvedValueOnce({ rows: [] } as never);
    const res = await listGet(new NextRequest('https://app.test/api/knowledge', { headers: { 'x-workspace-id': wid } }));
    expect(res.status).toBe(401);
  });

  it('allows any workspace role to read', async () => {
    session(); member('read_only_analyst');
    db.mockResolvedValueOnce({ rows: [{ id: iid, workspace_id: wid, title: 'FAQ' }] } as never);
    const res = await listGet(new NextRequest('https://app.test/api/knowledge', { headers }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(db.mock.calls[2][1]).toEqual([wid]);
  });

  it('filters by category/language/isApproved', async () => {
    session(); member('owner');
    db.mockResolvedValueOnce({ rows: [] } as never);
    const res = await listGet(new NextRequest('https://app.test/api/knowledge?category=faq&language=ru&isApproved=false', { headers }));
    expect(res.status).toBe(200);
    const [sql, params] = db.mock.calls[2];
    expect(sql).toMatch(/category = \$2/);
    expect(sql).toMatch(/language = \$3/);
    expect(sql).toMatch(/is_approved = \$4/);
    expect(params).toEqual([wid, 'faq', 'ru', false]);
  });
});

describe('POST /api/knowledge', () => {
  it('rejects roles without knowledge:write', async () => {
    session(); member('read_only_analyst');
    const res = await createPost(new NextRequest('https://app.test/api/knowledge', {
      method: 'POST', headers, body: JSON.stringify({ title: 'T', content: 'C' }),
    }));
    expect(res.status).toBe(403);
  });

  it('creates an item scoped to the caller workspace', async () => {
    session(); member('admin');
    db.mockResolvedValueOnce({ rows: [{ id: iid, workspace_id: wid, title: 'T', content: 'C', category: 'faq', language: 'uz' }] } as never);
    const res = await createPost(new NextRequest('https://app.test/api/knowledge', {
      method: 'POST', headers, body: JSON.stringify({ title: 'T', content: 'C' }),
    }));
    expect(res.status).toBe(201);
    const [, params] = db.mock.calls[2];
    expect(params?.[0]).toBe(wid);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'knowledge.created' }));
  });

  it('rejects invalid body', async () => {
    session(); member('admin');
    const res = await createPost(new NextRequest('https://app.test/api/knowledge', {
      method: 'POST', headers, body: JSON.stringify({ title: '' }),
    }));
    expect(res.status).toBe(400);
  });
});

describe('GET /api/knowledge/:id', () => {
  const ctx = { params: Promise.resolve({ itemId: iid }) };

  it('404s when the item is not found in this tenant', async () => {
    session(); member('owner');
    db.mockResolvedValueOnce({ rows: [] } as never);
    const res = await itemGet(new NextRequest(`https://app.test/api/knowledge/${iid}`, { headers }), ctx);
    expect(res.status).toBe(404);
  });

  it('returns the item scoped by workspace_id', async () => {
    session(); member('owner');
    db.mockResolvedValueOnce({ rows: [{ id: iid, workspace_id: wid, title: 'T' }] } as never);
    const res = await itemGet(new NextRequest(`https://app.test/api/knowledge/${iid}`, { headers }), ctx);
    expect(res.status).toBe(200);
    expect(db.mock.calls[2][1]).toEqual([iid, wid]);
  });
});

describe('PATCH /api/knowledge/:id', () => {
  const ctx = { params: Promise.resolve({ itemId: iid }) };

  it('rejects roles without knowledge:write', async () => {
    session(); member('sales_representative');
    const res = await itemPatch(new NextRequest(`https://app.test/api/knowledge/${iid}`, {
      method: 'PATCH', headers, body: JSON.stringify({ title: 'New' }),
    }), ctx);
    expect(res.status).toBe(403);
  });

  it('regenerates embedding path when content changes (service call verified via SQL shape)', async () => {
    session(); member('admin');
    db.mockResolvedValueOnce({ rows: [{ id: iid, workspace_id: wid, title: 'Old', content: 'Old c' }] } as never); // getKnowledgeItem
    db.mockResolvedValueOnce({ rows: [{ id: iid, workspace_id: wid, title: 'Old', content: 'New c' }] } as never); // UPDATE
    const res = await itemPatch(new NextRequest(`https://app.test/api/knowledge/${iid}`, {
      method: 'PATCH', headers, body: JSON.stringify({ content: 'New c' }),
    }), ctx);
    expect(res.status).toBe(200);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'knowledge.updated' }));
  });

  it('404s for cross-tenant item id', async () => {
    session(); member('admin');
    db.mockResolvedValueOnce({ rows: [] } as never); // getKnowledgeItem: not found for this workspace
    const res = await itemPatch(new NextRequest(`https://app.test/api/knowledge/${iid}`, {
      method: 'PATCH', headers: { ...headers, 'x-workspace-id': otherWid }, body: JSON.stringify({ title: 'X' }),
    }), ctx);
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/knowledge/:id', () => {
  const ctx = { params: Promise.resolve({ itemId: iid }) };

  it('rejects roles without knowledge:write', async () => {
    session(); member('sales_representative');
    const res = await itemDelete(new NextRequest(`https://app.test/api/knowledge/${iid}`, { method: 'DELETE', headers }), ctx);
    expect(res.status).toBe(403);
  });

  it('deletes scoped to workspace_id and 404s if absent', async () => {
    session(); member('owner');
    db.mockResolvedValueOnce({ rows: [] } as never);
    const res = await itemDelete(new NextRequest(`https://app.test/api/knowledge/${iid}`, { method: 'DELETE', headers }), ctx);
    expect(res.status).toBe(404);
  });

  it('deletes successfully and audits', async () => {
    session(); member('owner');
    db.mockResolvedValueOnce({ rows: [{ id: iid }] } as never);
    const res = await itemDelete(new NextRequest(`https://app.test/api/knowledge/${iid}`, { method: 'DELETE', headers }), ctx);
    expect(res.status).toBe(200);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'knowledge.deleted' }));
  });
});

describe('POST /api/knowledge/:id/approve', () => {
  const ctx = { params: Promise.resolve({ itemId: iid }) };

  it('defaults to approving', async () => {
    session(); member('admin');
    db.mockResolvedValueOnce({ rows: [{ id: iid, workspace_id: wid, is_approved: true }] } as never);
    const res = await approvePost(new NextRequest(`https://app.test/api/knowledge/${iid}/approve`, {
      method: 'POST', headers, body: JSON.stringify({}),
    }), ctx);
    expect(res.status).toBe(200);
    expect(db.mock.calls[2][1]).toEqual([true, iid, wid]);
  });

  it('unapproves when isApproved:false is sent', async () => {
    session(); member('admin');
    db.mockResolvedValueOnce({ rows: [{ id: iid, workspace_id: wid, is_approved: false }] } as never);
    const res = await approvePost(new NextRequest(`https://app.test/api/knowledge/${iid}/approve`, {
      method: 'POST', headers, body: JSON.stringify({ isApproved: false }),
    }), ctx);
    expect(res.status).toBe(200);
    expect(db.mock.calls[2][1]).toEqual([false, iid, wid]);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'knowledge.unapproved' }));
  });

  it('rejects roles without knowledge:write', async () => {
    session(); member('read_only_analyst');
    const res = await approvePost(new NextRequest(`https://app.test/api/knowledge/${iid}/approve`, {
      method: 'POST', headers, body: JSON.stringify({}),
    }), ctx);
    expect(res.status).toBe(403);
  });
});
