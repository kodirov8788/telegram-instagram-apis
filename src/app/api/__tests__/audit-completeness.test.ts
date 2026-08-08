import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/db', () => ({
  query: vi.fn(),
  identityTransaction: vi.fn(async (_userId: string, operation: (client: { query: typeof query }) => unknown) => operation({ query })),
  tenantTransaction: vi.fn(async (_userId: string, operation: (client: { query: typeof query }) => unknown) => operation({ query })),
  default: { connect: vi.fn() },
}));
vi.mock('@/lib/services/audit-log', () => ({ AuditLogService: { logEvent: vi.fn() } }));
vi.mock('bcryptjs', () => ({ compare: vi.fn(), hash: vi.fn() }));

import { compare } from 'bcryptjs';
import { query, default as pool } from '@/lib/db';
import { AuditLogService } from '@/lib/services/audit-log';
import { POST as login } from '../auth/login/route';
import { POST as logout } from '../auth/logout/route';
import { POST as register } from '../auth/register/route';
import { PATCH as patchConversation } from '../conversations/route';
import { PATCH as patchMember, DELETE as deleteMember } from '../workspace/members/[userId]/route';
import { POST as createInvitation } from '../workspace/invitations/route';
import { POST as acceptInvitation } from '../invitations/accept/route';

const db = vi.mocked(query);
const audit = vi.mocked(AuditLogService.logEvent);

const wid = '11111111-1111-4111-8111-111111111111';
const uid = 'user-1';
const targetUid = '22222222-2222-4222-8222-222222222222';
const headers = { cookie: `session=${'a'.repeat(64)}`, 'x-workspace-id': wid, 'content-type': 'application/json' };
const session = () => db.mockResolvedValueOnce({ rows: [{ user_id: uid, email: 'u@test.dev' }] } as never);
const member = (role = 'admin') => db.mockResolvedValueOnce({ rows: [{ role }] } as never);

beforeEach(() => {
  db.mockReset();
  audit.mockReset();
  vi.mocked(compare).mockReset();
});

describe('auth route audit logging', () => {
  it('logs auth.login on success', async () => {
    db.mockResolvedValueOnce({ rows: [{ id: uid, email: 'u@test.dev', password_hash: '$2a$10$invalidbcryptplaceholderxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' }] } as never);
    vi.mocked(compare).mockResolvedValueOnce(true as never);
    const req = new NextRequest('https://app.test/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'u@test.dev', password: 'password123' }) });
    const res = await login(req);
    expect(res.status).toBe(200);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.login', actorType: 'user', actorId: uid, entityId: uid }));
  });

  it('logs auth.logout when a valid session exists', async () => {
    session();
    db.mockResolvedValueOnce({ rows: [] } as never); // revokeSession UPDATE
    const req = new NextRequest('https://app.test/api/auth/logout', { method: 'POST', headers: { cookie: `session=${'a'.repeat(64)}` } });
    const res = await logout(req);
    expect(res.status).toBe(200);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.logout', actorType: 'user', actorId: uid }));
  });

  it('logs auth.register on account creation', async () => {
    const client = { query: vi.fn(), release: vi.fn() };
    client.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: uid, email: 'new@test.dev', full_name: 'New User' }] } as never) // INSERT
      .mockResolvedValueOnce({ rows: [] } as never) // session insert
      .mockResolvedValueOnce(undefined); // COMMIT
    vi.mocked(pool.connect).mockResolvedValueOnce(client as never);
    const req = new NextRequest('https://app.test/api/auth/register', { method: 'POST', body: JSON.stringify({ email: 'new@test.dev', fullName: 'New User', password: 'password12345' }) });
    const res = await register(req);
    expect(res.status).toBe(201);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.register', actorType: 'user', actorId: uid, entityId: uid }));
  });
});

describe('conversation mode change audit', () => {
  it('logs conversation.mode_changed with previous and new mode', async () => {
    session();
    member('support_operator');
    db.mockResolvedValueOnce({ rows: [{ status: 'new', mode: 'auto' }] } as never); // before SELECT
    db.mockResolvedValueOnce({ rows: [{ id: '33333333-3333-4333-8333-333333333333', status: 'new', mode: 'human' }] } as never); // UPDATE

    const req = new NextRequest('https://app.test/api/conversations', {
      method: 'PATCH', headers, body: JSON.stringify({ conversationId: '33333333-3333-4333-8333-333333333333', mode: 'human' }),
    });
    const res = await patchConversation(req);
    expect(res.status).toBe(200);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'conversation.mode_changed', entityType: 'conversation', entityId: '33333333-3333-4333-8333-333333333333',
      previousValue: { mode: 'auto' }, newValue: { mode: 'human' },
    }));
  });
});

describe('workspace member audit logging', () => {
  it('logs member.role_changed with previous/new role', async () => {
    session();
    member('owner');
    db.mockResolvedValueOnce({ rows: [{ role: 'support_operator' }] } as never); // locked SELECT
    db.mockResolvedValueOnce({ rows: [{ user_id: targetUid, role: 'sales_manager' }] } as never); // UPDATE

    const req = new NextRequest(`https://app.test/api/workspace/members/${targetUid}`, {
      method: 'PATCH', headers, body: JSON.stringify({ role: 'sales_manager' }),
    });
    const res = await patchMember(req, { params: Promise.resolve({ userId: targetUid }) });
    expect(res.status).toBe(200);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'member.role_changed', entityType: 'workspace_member', entityId: targetUid,
      previousValue: { role: 'support_operator' }, newValue: { role: 'sales_manager' },
    }));
  });

  it('logs member.removed on delete', async () => {
    session();
    member('owner');
    db.mockResolvedValueOnce({ rows: [{ role: 'support_operator' }] } as never); // locked SELECT
    db.mockResolvedValueOnce({ rows: [{ user_id: targetUid }] } as never); // DELETE

    const req = new NextRequest(`https://app.test/api/workspace/members/${targetUid}`, { method: 'DELETE', headers });
    const res = await deleteMember(req, { params: Promise.resolve({ userId: targetUid }) });
    expect(res.status).toBe(204);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'member.removed', entityType: 'workspace_member', entityId: targetUid,
      previousValue: { role: 'support_operator' },
    }));
  });
});

describe('invitation audit logging', () => {
  it('logs invitation.created on POST', async () => {
    session();
    member('owner');
    db.mockResolvedValueOnce({ rows: [] } as never); // stale-invite cleanup UPDATE
    db.mockResolvedValueOnce({ rows: [{ id: 'inv-1', email: 'invitee@test.dev', role: 'support_operator', expires_at: new Date() }] } as never); // INSERT

    const req = new NextRequest('https://app.test/api/workspace/invitations', {
      method: 'POST', headers, body: JSON.stringify({ email: 'invitee@test.dev', role: 'support_operator' }),
    });
    const res = await createInvitation(req);
    expect(res.status).toBe(201);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'invitation.created', entityType: 'workspace_invitation', entityId: 'inv-1',
      newValue: { email: 'invitee@test.dev', role: 'support_operator' },
    }));
  });

  it('logs invitation.accepted on accept', async () => {
    session();
    db.mockResolvedValueOnce({ rows: [{ workspace_id: wid, role: 'support_operator' }] } as never); // accept_workspace_invitation()

    const req = new NextRequest('https://app.test/api/invitations/accept', {
      method: 'POST', headers: { cookie: `session=${'a'.repeat(64)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'a'.repeat(64) }),
    });
    const res = await acceptInvitation(req);
    expect(res.status).toBe(200);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'invitation.accepted', entityType: 'workspace_invitation', entityId: wid,
      actorId: uid, newValue: { role: 'support_operator' },
    }));
  });
});
