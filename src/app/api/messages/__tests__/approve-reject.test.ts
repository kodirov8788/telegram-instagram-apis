import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/db', () => ({
  query: vi.fn(),
  identityTransaction: vi.fn(async (_userId: string, operation: (client: { query: typeof query }) => unknown) => operation({ query })),
  tenantTransaction: vi.fn(async (_userId: string, operation: (client: { query: typeof query }) => unknown) => operation({ query })),
  default: { connect: vi.fn() },
}));
vi.mock('@/lib/services/audit-log', () => ({ AuditLogService: { logEvent: vi.fn() } }));

const mocks = vi.hoisted(() => {
  class MockDuplicateActiveJobError extends Error {}
  return {
    createJob: vi.fn().mockResolvedValue({ id: 'job-1' }),
    enqueueOutboundJob: vi.fn().mockResolvedValue(undefined),
    MockDuplicateActiveJobError,
  };
});
vi.mock('@/lib/services/outbound-jobs', () => ({
  createJob: mocks.createJob,
  enqueueOutboundJob: mocks.enqueueOutboundJob,
  DuplicateActiveJobError: mocks.MockDuplicateActiveJobError,
}));
const { createJob, enqueueOutboundJob, MockDuplicateActiveJobError } = mocks;

import { query } from '@/lib/db';
import { AuditLogService } from '@/lib/services/audit-log';
import { POST as approve } from '../[messageId]/approve/route';
import { POST as reject } from '../[messageId]/reject/route';

const db = vi.mocked(query);
const audit = vi.mocked(AuditLogService.logEvent);

const wid = '11111111-1111-4111-8111-111111111111';
const mid = '22222222-2222-4222-8222-222222222222';
const uid = 'user-1';
const headers = { cookie: `session=${'a'.repeat(64)}`, 'x-workspace-id': wid, 'content-type': 'application/json' };

const ctx = { params: Promise.resolve({ messageId: mid }) };
const req = (url: string, body?: object) => new NextRequest(url, { headers, ...(body ? { method: 'POST', body: JSON.stringify(body) } : { method: 'POST' }) });

const session = () => db.mockResolvedValueOnce({ rows: [{ user_id: uid, email: 'u@test.dev' }] } as never);
const member = (role = 'support_operator') => db.mockResolvedValueOnce({ rows: [{ role }] } as never);
const claimRow = () =>
  db.mockResolvedValueOnce({
    rows: [{
      id: mid, content: 'Our hours are 9-6.', conversation_id: 'conv-1', channel: 'telegram',
      connection_id: 'conn-1', workspace_id: wid, telegram_id: 'tg-user-1', instagram_id: null,
    }],
  } as never);

beforeEach(() => {
  db.mockReset();
  audit.mockReset();
  createJob.mockClear();
  createJob.mockResolvedValue({ id: 'job-1' });
  enqueueOutboundJob.mockClear();
  enqueueOutboundJob.mockResolvedValue(undefined);
});

describe('POST /api/messages/:id/approve', () => {
  it('approves a pending draft, creates exactly one outbound job in the same transaction as the claim, and audit-logs it', async () => {
    session();
    member();
    claimRow(); // atomic claim UPDATE, commits 'approved' before job creation is attempted
    db.mockResolvedValueOnce({ rows: [] } as never); // SAVEPOINT job_creation

    const res = await approve(req(`https://app.test/api/messages/${mid}/approve`), ctx);

    expect(res.status).toBe(200);
    expect(createJob).toHaveBeenCalledTimes(1);
    expect(createJob).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: mid,
        recipientId: 'tg-user-1',
        channel: 'telegram',
        connectionId: 'conn-1',
        workspaceId: wid,
        content: 'Our hours are 9-6.',
      }),
      expect.objectContaining({ query: db })
    );
    expect(enqueueOutboundJob).toHaveBeenCalledWith(expect.objectContaining({ query: db }), 'job-1');
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'message.approved', entityId: mid }));
  });

  it('rolls back the whole transaction (approval included) if job creation fails for a reason other than a duplicate', async () => {
    session();
    member();
    claimRow();
    db.mockResolvedValueOnce({ rows: [] } as never); // SAVEPOINT job_creation
    createJob.mockRejectedValueOnce(new Error('db unavailable'));

    const res = await approve(req(`https://app.test/api/messages/${mid}/approve`), ctx);

    expect(res.status).toBe(500);
    // No separate "mark failed" statement exists anymore — a non-duplicate
    // failure here means the entire tenantTransaction (including the claim
    // UPDATE) rolls back, so the message reverts to 'pending_approval' and
    // can simply be approved again; nothing is left stranded as 'approved'.
    const failedUpdate = db.mock.calls.find(c => typeof c[0] === 'string' && c[0].includes("delivery_status = 'failed'"));
    expect(failedUpdate).toBeFalsy();
  });

  it('keeps the approval but skips job creation when createJob reports a duplicate active job (concurrent approval race)', async () => {
    session();
    member();
    claimRow();
    db.mockResolvedValueOnce({ rows: [] } as never); // SAVEPOINT job_creation
    createJob.mockRejectedValueOnce(new MockDuplicateActiveJobError('dup'));
    db.mockResolvedValueOnce({ rows: [] } as never); // ROLLBACK TO SAVEPOINT job_creation

    const res = await approve(req(`https://app.test/api/messages/${mid}/approve`), ctx);

    expect(res.status).toBe(200);
    expect(createJob).toHaveBeenCalledTimes(1);
    expect(enqueueOutboundJob).not.toHaveBeenCalled();
    expect(db.mock.calls.some(c => c[0] === 'ROLLBACK TO SAVEPOINT job_creation')).toBe(true);
    // The approval itself (audit-logged, claim already committed as part of
    // this same transaction) is not undone by the savepoint rollback.
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'message.approved', entityId: mid }));
  });

  it('rejects a duplicate/concurrent approve of the same message (already-resolved row matches 0 rows)', async () => {
    session();
    member();
    db.mockResolvedValueOnce({ rows: [] } as never); // atomic UPDATE matched nothing — already approved by a concurrent caller
    db.mockResolvedValueOnce({ rows: [{ delivery_status: 'sent' }] } as never); // probe for the error message

    const res = await approve(req(`https://app.test/api/messages/${mid}/approve`), ctx);

    expect(res.status).toBe(409);
    expect(createJob).not.toHaveBeenCalled();
  });

  it('rejects approving a draft whose conversation has moved to human mode', async () => {
    session();
    member();
    db.mockResolvedValueOnce({ rows: [] } as never); // atomic UPDATE excluded it via c.mode <> 'human'
    db.mockResolvedValueOnce({ rows: [{ delivery_status: 'pending_approval', mode: 'human' }] } as never);

    const res = await approve(req(`https://app.test/api/messages/${mid}/approve`), ctx);

    expect(res.status).toBe(409);
    expect(createJob).not.toHaveBeenCalled();
  });

  it('returns 404 for a message that does not exist in this workspace', async () => {
    session();
    member();
    db.mockResolvedValueOnce({ rows: [] } as never);
    db.mockResolvedValueOnce({ rows: [] } as never); // probe finds nothing either — cross-tenant or nonexistent

    const res = await approve(req(`https://app.test/api/messages/${mid}/approve`), ctx);
    expect(res.status).toBe(404);
  });
});

describe('POST /api/messages/:id/reject', () => {
  it('rejects a pending draft with a reason and never creates a job', async () => {
    session();
    member();
    db.mockResolvedValueOnce({ rows: [{ id: mid, conversation_id: 'conv-1' }] } as never);

    const res = await reject(req(`https://app.test/api/messages/${mid}/reject`, { reason: 'Wrong price quoted' }), ctx);

    expect(res.status).toBe(200);
    expect(createJob).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'message.rejected', entityId: mid }));
    expect(db.mock.calls.some(c => Array.isArray(c[1]) && c[1].includes('Wrong price quoted'))).toBe(true);
  });

  it('rejects a duplicate/concurrent reject of the same message', async () => {
    session();
    member();
    db.mockResolvedValueOnce({ rows: [] } as never);
    db.mockResolvedValueOnce({ rows: [{ delivery_status: 'rejected' }] } as never);

    const res = await reject(req(`https://app.test/api/messages/${mid}/reject`, {}), ctx);
    expect(res.status).toBe(409);
  });
});
