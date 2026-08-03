import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
vi.mock('@/lib/db', () => ({ query: vi.fn(), identityTransaction: vi.fn(async (_userId: string, operation: (client: { query: typeof query }) => unknown) => operation({ query })), tenantTransaction: vi.fn(async (_userId: string, operation: (client: { query: typeof query }) => unknown) => operation({ query })), default: { connect: vi.fn() } }));
vi.mock('@/lib/services/workspace', () => ({ WorkspaceService: { createWorkspace: vi.fn(), getWorkspaceById: vi.fn(), updateWorkspaceConfig: vi.fn() } }));
import { query } from '@/lib/db';
import { WorkspaceService } from '@/lib/services/workspace';
import { POST as createWorkspace } from '../workspace/route';
import { PATCH as patchConversation } from '../conversations/route';
import { GET as exportLeads } from '../leads/export/route';
const db = vi.mocked(query); const ws = vi.mocked(WorkspaceService);
const wid = '11111111-1111-4111-8111-111111111111'; const cid = '22222222-2222-4222-8222-222222222222';
const headers = { cookie: `session=${'a'.repeat(64)}`, 'x-workspace-id': wid, 'content-type': 'application/json' };
beforeEach(() => { db.mockReset(); vi.clearAllMocks(); });
const session = () => db.mockResolvedValueOnce({ rows: [{ user_id: 'user-1', email: 'u@test.dev' }] } as never);
const member = (role: string) => db.mockResolvedValueOnce({ rows: [{ role }] } as never);

describe('tenant route enforcement', () => {
  it('derives workspace owner exclusively from authenticated session', async () => {
    session(); ws.createWorkspace.mockResolvedValue({ id: wid, name: 'Acme' } as never);
    const req = new NextRequest('https://app.test/api/workspace', { method: 'POST', headers, body: JSON.stringify({ name: 'Acme' }) });
    expect((await createWorkspace(req)).status).toBe(201);
    expect(ws.createWorkspace).toHaveBeenCalledWith(expect.objectContaining({ name: 'Acme' }), expect.objectContaining({ query: db }));
  });
  it('rejects a body-supplied owner id', async () => {
    session(); const req = new NextRequest('https://app.test/api/workspace', { method: 'POST', headers, body: JSON.stringify({ name: 'Acme', ownerUserId: 'attacker' }) });
    expect((await createWorkspace(req)).status).toBe(400); expect(ws.createWorkspace).not.toHaveBeenCalled();
  });
  it('scopes conversation mutation by workspace and hides cross-tenant ids', async () => {
    session(); member('support_operator'); db.mockResolvedValueOnce({ rows: [] } as never);
    const req = new NextRequest('https://app.test/api/conversations', { method: 'PATCH', headers, body: JSON.stringify({ conversationId: cid, status: 'closed' }) });
    expect((await patchConversation(req)).status).toBe(404);
    expect(db.mock.calls[2][0]).toContain('workspace_id = $4'); expect(db.mock.calls[2][1]).toEqual(['closed', undefined, cid, wid]);
  });
  it('prevents CSV spreadsheet formulas and scopes export to authorized tenant', async () => {
    session(); member('read_only_analyst'); db.mockResolvedValueOnce({ rows: [{ id: cid, full_name: '=HYPERLINK("bad")', status: 'new_lead', score: 1 }] } as never);
    const res = await exportLeads(new NextRequest('https://app.test/api/leads/export', { headers })); const text = await res.text();
    expect(res.status).toBe(200); expect(text).toContain("'=HYPERLINK"); expect(db.mock.calls[2][1]).toEqual([wid]);
  });
  it('rejects an unauthorized export after live demotion', async () => {
    session(); member('support_operator'); const res = await exportLeads(new NextRequest('https://app.test/api/leads/export', { headers }));
    expect(res.status).toBe(403); expect(db).toHaveBeenCalledTimes(2);
  });
});
