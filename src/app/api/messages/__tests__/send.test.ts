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
import { POST as send } from '../route';

const db = vi.mocked(query);
const audit = vi.mocked(AuditLogService.logEvent);

const wid = '11111111-1111-4111-8111-111111111111';
const cid = '33333333-3333-4333-8333-333333333333';
const mid = '22222222-2222-4222-8222-222222222222';
const uid = 'user-1';
const headers = { cookie: `session=${'a'.repeat(64)}`, 'x-workspace-id': wid, 'content-type': 'application/json' };

const req = (body: object) =>
  new NextRequest('https://app.test/api/messages', { method: 'POST', headers, body: JSON.stringify(body) });

const session = () => db.mockResolvedValueOnce({ rows: [{ user_id: uid, email: 'u@test.dev' }] } as never);
const member = (role = 'support_operator') => db.mockResolvedValueOnce({ rows: [{ role }] } as never);
const conversationRow = (overrides: Record<string, unknown> = {}) =>
  db.mockResolvedValueOnce({
    rows: [{
      conversation_id: cid, workspace_id: wid, channel: 'telegram', connection_id: 'conn-1', mode: 'human',
      telegram_id: 'tg-user-1', instagram_id: null, connection_active: true, ...overrides,
    }],
  } as never);
const noDuplicate = () => db.mockResolvedValueOnce({ rows: [] } as never);
const insertedMessage = () => db.mockResolvedValueOnce({ rows: [{ id: mid, conversation_id: cid }] } as never);

beforeEach(() => {
  db.mockReset();
  audit.mockReset();
  createJob.mockClear();
  createJob.mockResolvedValue({ id: 'job-1' });
  enqueueOutboundJob.mockClear();
  enqueueOutboundJob.mockResolvedValue(undefined);
});

describe('POST /api/messages', () => {
  it('sends a Telegram reply, creates an outbound job in the same transaction, and audit-logs it', async () => {
    session();
    member();
    conversationRow();
    noDuplicate();
    insertedMessage();
    db.mockResolvedValueOnce({ rows: [] } as never); // SAVEPOINT job_creation

    const res = await send(req({ conversationId: cid, content: 'We can help with that.' }));

    expect(res.status).toBe(201);
    expect(createJob).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: wid,
        connectionId: 'conn-1',
        channel: 'telegram',
        messageId: mid,
        recipientId: 'tg-user-1',
        content: 'We can help with that.',
      }),
      expect.objectContaining({ query: db })
    );
    expect(enqueueOutboundJob).toHaveBeenCalledWith(expect.objectContaining({ query: db }), 'job-1');
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'message.sent_by_operator', entityId: mid }));
  });

  it('sends an Instagram reply using the customer instagram_id', async () => {
    session();
    member();
    conversationRow({ channel: 'instagram', telegram_id: null, instagram_id: 'ig-user-1' });
    noDuplicate();
    insertedMessage();
    db.mockResolvedValueOnce({ rows: [] } as never); // SAVEPOINT job_creation

    const res = await send(req({ conversationId: cid, content: 'Sure thing!' }));

    expect(res.status).toBe(201);
    expect(createJob).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'instagram', recipientId: 'ig-user-1' }),
      expect.anything()
    );
  });

  it('returns 401 when unauthenticated', async () => {
    db.mockResolvedValueOnce({ rows: [] } as never); // authenticate() finds no session row

    const res = await send(req({ conversationId: cid, content: 'hi' }));
    expect(res.status).toBe(401);
    expect(createJob).not.toHaveBeenCalled();
  });

  it('returns 404 for a conversation in a different tenant / that does not exist', async () => {
    session();
    member();
    db.mockResolvedValueOnce({ rows: [] } as never); // conversation lookup finds nothing

    const res = await send(req({ conversationId: cid, content: 'hi' }));
    expect(res.status).toBe(404);
    expect(createJob).not.toHaveBeenCalled();
  });

  it('returns 409 when the conversation is not in human mode', async () => {
    session();
    member();
    conversationRow({ mode: 'auto' });

    const res = await send(req({ conversationId: cid, content: 'hi' }));
    expect(res.status).toBe(409);
    expect(createJob).not.toHaveBeenCalled();
  });

  it('returns 409 when the channel connection is inactive', async () => {
    session();
    member();
    conversationRow({ connection_active: false });

    const res = await send(req({ conversationId: cid, content: 'hi' }));
    expect(res.status).toBe(409);
    expect(createJob).not.toHaveBeenCalled();
  });

  it('deduplicates a rapid double-submit of identical content without creating a second job', async () => {
    session();
    member();
    conversationRow();
    db.mockResolvedValueOnce({ rows: [{ id: mid, conversation_id: cid }] } as never); // duplicate found

    const res = await send(req({ conversationId: cid, content: 'We can help with that.' }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message.deduplicated).toBe(true);
    expect(createJob).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('keeps the message but skips job creation when createJob reports a duplicate active job', async () => {
    session();
    member();
    conversationRow();
    noDuplicate();
    insertedMessage();
    db.mockResolvedValueOnce({ rows: [] } as never); // SAVEPOINT job_creation
    createJob.mockRejectedValueOnce(new MockDuplicateActiveJobError('dup'));
    db.mockResolvedValueOnce({ rows: [] } as never); // ROLLBACK TO SAVEPOINT job_creation

    const res = await send(req({ conversationId: cid, content: 'hi' }));

    expect(res.status).toBe(201);
    expect(enqueueOutboundJob).not.toHaveBeenCalled();
    expect(db.mock.calls.some(c => c[0] === 'ROLLBACK TO SAVEPOINT job_creation')).toBe(true);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'message.sent_by_operator' }));
  });
});
