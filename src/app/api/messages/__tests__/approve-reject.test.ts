import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/db', () => ({
  query: vi.fn(),
  identityTransaction: vi.fn(async (_userId: string, operation: (client: { query: typeof query }) => unknown) => operation({ query })),
  tenantTransaction: vi.fn(async (_userId: string, operation: (client: { query: typeof query }) => unknown) => operation({ query })),
  default: { connect: vi.fn() },
}));
vi.mock('@/lib/services/audit-log', () => ({ AuditLogService: { logEvent: vi.fn() } }));

const mocks = vi.hoisted(() => ({ dispatchOutboundMessage: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/services/ai-intelligence', () => ({ AIIntelligenceService: { dispatchOutboundMessage: mocks.dispatchOutboundMessage } }));
const dispatchOutboundMessage = mocks.dispatchOutboundMessage;

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

beforeEach(() => {
  db.mockReset();
  audit.mockReset();
  dispatchOutboundMessage.mockClear();
});

describe('POST /api/messages/:id/approve', () => {
  it('approves a pending draft, dispatches exactly once, and audit-logs it', async () => {
    session();
    member();
    db.mockResolvedValueOnce({
      rows: [{
        id: mid, content: 'Our hours are 9-6.', conversation_id: 'conv-1', channel: 'telegram',
        connection_id: 'conn-1', workspace_id: wid, telegram_id: 'tg-user-1', instagram_id: null,
      }],
    } as never); // atomic claim UPDATE, commits 'approved' before any dispatch is attempted
    db.mockResolvedValueOnce({ rows: [] } as never); // follow-up UPDATE -> 'sent', outside the claim transaction

    const res = await approve(req(`https://app.test/api/messages/${mid}/approve`), ctx);

    expect(res.status).toBe(200);
    expect(dispatchOutboundMessage).toHaveBeenCalledTimes(1);
    expect(dispatchOutboundMessage).toHaveBeenCalledWith(expect.objectContaining({ channelUserIdentifier: 'tg-user-1' }), 'Our hours are 9-6.');
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'message.approved', entityId: mid }));
    const sentUpdate = db.mock.calls.find(c => typeof c[0] === 'string' && c[0].includes("delivery_status = 'sent'"));
    expect(sentUpdate).toBeTruthy();
  });

  it('marks the message failed (not left as approved-but-silent) if dispatch fails after the approval already committed', async () => {
    session();
    member();
    db.mockResolvedValueOnce({
      rows: [{
        id: mid, content: 'Our hours are 9-6.', conversation_id: 'conv-1', channel: 'telegram',
        connection_id: 'conn-1', workspace_id: wid, telegram_id: 'tg-user-1', instagram_id: null,
      }],
    } as never);
    db.mockResolvedValueOnce({ rows: [] } as never); // follow-up UPDATE -> 'failed'
    dispatchOutboundMessage.mockRejectedValueOnce(new Error('telegram unavailable'));

    const res = await approve(req(`https://app.test/api/messages/${mid}/approve`), ctx);

    expect(res.status).toBe(500);
    const failedUpdate = db.mock.calls.find(c => typeof c[0] === 'string' && c[0].includes("delivery_status = 'failed'"));
    expect(failedUpdate).toBeTruthy();
    expect(failedUpdate![1]).toEqual([mid]);
    // The approval itself was already committed and is not retried/re-approvable from this call.
    const sentUpdate = db.mock.calls.find(c => typeof c[0] === 'string' && c[0].includes("delivery_status = 'sent'"));
    expect(sentUpdate).toBeFalsy();
  });

  it('rejects a duplicate/concurrent approve of the same message (already-resolved row matches 0 rows)', async () => {
    session();
    member();
    db.mockResolvedValueOnce({ rows: [] } as never); // atomic UPDATE matched nothing — already approved by a concurrent caller
    db.mockResolvedValueOnce({ rows: [{ delivery_status: 'sent' }] } as never); // probe for the error message

    const res = await approve(req(`https://app.test/api/messages/${mid}/approve`), ctx);

    expect(res.status).toBe(409);
    expect(dispatchOutboundMessage).not.toHaveBeenCalled();
  });

  it('rejects approving a draft whose conversation has moved to human mode', async () => {
    session();
    member();
    db.mockResolvedValueOnce({ rows: [] } as never); // atomic UPDATE excluded it via c.mode <> 'human'
    db.mockResolvedValueOnce({ rows: [{ delivery_status: 'pending_approval', mode: 'human' }] } as never);

    const res = await approve(req(`https://app.test/api/messages/${mid}/approve`), ctx);

    expect(res.status).toBe(409);
    expect(dispatchOutboundMessage).not.toHaveBeenCalled();
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
  it('rejects a pending draft with a reason and never dispatches', async () => {
    session();
    member();
    db.mockResolvedValueOnce({ rows: [{ id: mid, conversation_id: 'conv-1' }] } as never);

    const res = await reject(req(`https://app.test/api/messages/${mid}/reject`, { reason: 'Wrong price quoted' }), ctx);

    expect(res.status).toBe(200);
    expect(dispatchOutboundMessage).not.toHaveBeenCalled();
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
