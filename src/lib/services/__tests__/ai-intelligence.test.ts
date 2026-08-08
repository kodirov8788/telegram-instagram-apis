import { beforeEach, describe, expect, it, vi } from 'vitest';

// pool.connect() returns a client whose query() is the SAME mock as the
// plain top-level query() — so a test asserting on db.mock.calls sees both
// the transaction's client.query() calls and any plain query() calls in
// one combined, order-preserving list, matching how the real code
// interleaves them within the auto-mode transaction.
const dbMocks = vi.hoisted(() => ({ query: vi.fn(), connect: vi.fn() }));
vi.mock('../../db', () => ({ query: dbMocks.query, default: { connect: dbMocks.connect } }));
vi.mock('../ai-classifier', () => ({ AIClassifierService: { classifyMessage: vi.fn() } }));
vi.mock('../knowledge-base', () => ({ KnowledgeBaseService: { searchRelevantKnowledge: vi.fn() } }));
vi.mock('../audit-log', () => ({ AuditLogService: { logEvent: vi.fn() } }));
vi.mock('../inbound-persistence', () => ({ InboundPersistenceService: { persist: vi.fn() } }));

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
  sendDirectMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
}));
vi.mock('../telegram', () => ({ TelegramService: class { sendMessage = mocks.sendMessage; } }));
vi.mock('../instagram', () => ({ InstagramService: class { sendDirectMessage = mocks.sendDirectMessage; } }));
const { sendMessage, sendDirectMessage } = mocks;

const jobMocks = vi.hoisted(() => {
  class MockDuplicateActiveJobError extends Error {}
  return {
    createJob: vi.fn().mockResolvedValue({ id: 'job-1' }),
    enqueueOutboundJob: vi.fn().mockResolvedValue(undefined),
    MockDuplicateActiveJobError,
  };
});
vi.mock('../outbound-jobs', () => ({
  createJob: jobMocks.createJob,
  enqueueOutboundJob: jobMocks.enqueueOutboundJob,
  DuplicateActiveJobError: jobMocks.MockDuplicateActiveJobError,
}));
const { createJob, enqueueOutboundJob } = jobMocks;

import { query } from '../../db';
import { AIClassifierService } from '../ai-classifier';
import { KnowledgeBaseService } from '../knowledge-base';
import { AuditLogService } from '../audit-log';
import { InboundPersistenceService } from '../inbound-persistence';
import { AIIntelligenceService } from '../ai-intelligence';
import type { UnifiedMessageDTO } from '../message-queue';

const db = vi.mocked(query);
const connect = vi.mocked(dbMocks.connect);
const classify = vi.mocked(AIClassifierService.classifyMessage);
const search = vi.mocked(KnowledgeBaseService.searchRelevantKnowledge);
const audit = vi.mocked(AuditLogService.logEvent);
const persist = vi.mocked(InboundPersistenceService.persist);

const baseMsg: UnifiedMessageDTO = {
  workspaceId: 'ws-1',
  channel: 'telegram',
  channelUserIdentifier: 'tg-user-1',
  content: 'What are your hours?',
  messageType: 'text',
  rawPayload: {},
  connectionId: 'conn-1',
};

const NON_ESCALATING = { language: 'en', intent: 'general_inquiry', sentiment: 'neutral', confidenceScore: 0.9 };

const originalEnv = { ...process.env };

beforeEach(() => {
  db.mockReset();
  connect.mockReset();
  connect.mockResolvedValue({ query: db, release: vi.fn() });
  classify.mockReset();
  search.mockReset();
  audit.mockReset();
  persist.mockReset();
  sendMessage.mockClear();
  sendDirectMessage.mockClear();
  createJob.mockClear();
  createJob.mockResolvedValue({ id: 'job-1' });
  enqueueOutboundJob.mockClear();
  enqueueOutboundJob.mockResolvedValue(undefined);
  classify.mockResolvedValue(NON_ESCALATING as never);
  search.mockResolvedValue([] as never);
  process.env = { ...originalEnv, TELEGRAM_BOT_TOKEN: 'test-telegram-token' };
});

/** Wires the standard non-escalating, existing-conversation persist() result, then returns the mock for further chaining (e.g. the fresh mode read). */
function primeStandardFlow(initialMode: string) {
  persist.mockResolvedValueOnce({
    customerId: 'cust-1',
    conversationId: 'conv-1',
    conversationMode: initialMode as never,
    conversationStatus: 'ai_handling',
    messageId: 'msg-inbound-1',
    isDuplicateEvent: false,
  });
}

describe('AIIntelligenceService.processIncomingMessage — mode routing', () => {
  it('auto mode: inserts pending, creates exactly one outbound job, and never calls the provider synchronously — message insert, job creation, and enqueue are one transaction', async () => {
    primeStandardFlow('auto');
    db.mockResolvedValueOnce({ rows: [{ mode: 'auto' }] } as never); // fresh mode re-read
    db.mockResolvedValueOnce({
      rows: [{ workspace_id: 'ws-1', connection_id: 'conn-1', channel: 'telegram', recipient_id: 'tg-user-1' }],
    } as never); // conversations JOIN customers lookup
    db.mockResolvedValueOnce({ rows: [] } as never); // BEGIN
    db.mockResolvedValueOnce({ rows: [{ id: 'ai-msg-1' }] } as never); // AI message insert (status: pending)
    db.mockResolvedValueOnce({ rows: [] } as never); // COMMIT

    await AIIntelligenceService.processIncomingMessage(baseMsg);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(db.mock.calls.some(c => c[0] === 'BEGIN')).toBe(true);
    expect(db.mock.calls.some(c => c[0] === 'COMMIT')).toBe(true);
    expect(createJob).toHaveBeenCalledTimes(1);
    expect(createJob).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-1',
        connectionId: 'conn-1',
        channel: 'telegram',
        messageId: 'ai-msg-1',
        recipientId: 'tg-user-1',
      }),
      expect.objectContaining({ query: db }) // the transaction-scoped client from pool.connect()
    );
    expect(enqueueOutboundJob).toHaveBeenCalledWith(expect.objectContaining({ query: db }), 'job-1');
    const pendingInsert = db.mock.calls.find(c => typeof c[0] === 'string' && c[0].includes("'ai', $2, 'text', 'pending'"));
    expect(pendingInsert).toBeTruthy();
  });

  it('auto mode: rolls back the whole transaction (message insert included) if job creation throws — no stranded pending message', async () => {
    primeStandardFlow('auto');
    db.mockResolvedValueOnce({ rows: [{ mode: 'auto' }] } as never);
    db.mockResolvedValueOnce({
      rows: [{ workspace_id: 'ws-1', connection_id: 'conn-1', channel: 'telegram', recipient_id: 'tg-user-1' }],
    } as never);
    db.mockResolvedValueOnce({ rows: [] } as never); // BEGIN
    db.mockResolvedValueOnce({ rows: [{ id: 'ai-msg-2' }] } as never); // AI message insert — rolled back below
    db.mockResolvedValueOnce({ rows: [] } as never); // ROLLBACK
    createJob.mockRejectedValueOnce(new Error('queue unavailable'));

    await expect(AIIntelligenceService.processIncomingMessage(baseMsg)).rejects.toThrow('queue unavailable');

    expect(db.mock.calls.some(c => c[0] === 'ROLLBACK')).toBe(true);
    expect(db.mock.calls.some(c => c[0] === 'COMMIT')).toBe(false);
    // No separate "mark this message failed" statement — the message insert
    // itself never committed, so there's nothing stranded to mark.
    const failedUpdate = db.mock.calls.find(c => typeof c[0] === 'string' && c[0].includes("delivery_status = 'failed'"));
    expect(failedUpdate).toBeFalsy();
    expect(enqueueOutboundJob).not.toHaveBeenCalled();
  });

  it('approval mode: creates a pending_approval draft in one atomic statement and never dispatches', async () => {
    primeStandardFlow('approval');
    db.mockResolvedValueOnce({ rows: [{ mode: 'approval' }] } as never); // fresh mode re-read
    db.mockResolvedValueOnce({ rows: [{ id: 'draft-1' }] } as never); // combined supersede+insert

    await AIIntelligenceService.processIncomingMessage(baseMsg);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(sendDirectMessage).not.toHaveBeenCalled();
    expect(createJob).not.toHaveBeenCalled();
    const draftInsert = db.mock.calls.find(c => typeof c[0] === 'string' && c[0].includes('WITH existing AS'));
    expect(draftInsert).toBeTruthy();
    expect(draftInsert![0]).toContain("delivery_status = 'stale'");
    expect(draftInsert![0]).toContain("IN ('pending_approval', 'suggested')");
    expect(draftInsert![0]).toContain('source_provider_event_id');
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'message.draft_created', entityId: 'draft-1' }));
  });

  it('suggestion mode: creates a suggested message and never dispatches', async () => {
    primeStandardFlow('suggestion');
    db.mockResolvedValueOnce({ rows: [{ mode: 'suggestion' }] } as never);
    db.mockResolvedValueOnce({ rows: [{ id: 'suggestion-1' }] } as never); // combined supersede+insert

    await AIIntelligenceService.processIncomingMessage(baseMsg);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(createJob).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'message.suggestion_created', entityId: 'suggestion-1' }));
  });

  it('mode changed to human mid-generation: drops the reply instead of sending or drafting it (closes the stale-read race)', async () => {
    // Conversation was 'auto' at fetch time (step 2), but by the time we're
    // ready to persist the reply, a human has taken over — the fresh
    // re-read must be what decides the outcome, not the value from step 2.
    primeStandardFlow('auto');
    db.mockResolvedValueOnce({ rows: [{ mode: 'human' }] } as never); // fresh mode re-read: now human

    await AIIntelligenceService.processIncomingMessage(baseMsg);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(sendDirectMessage).not.toHaveBeenCalled();
    expect(createJob).not.toHaveBeenCalled();
    const aiInsertAttempted = db.mock.calls.some(
      c => typeof c[0] === 'string' && (c[0].includes("'ai', $2, 'text', 'pending'") || c[0].includes('pending_approval') || c[0].includes('suggested'))
    );
    expect(aiInsertAttempted).toBe(false);
  });

  it('duplicate provider event: persist() signals isDuplicateEvent and the rest of the pipeline is skipped', async () => {
    persist.mockResolvedValueOnce({
      customerId: 'cust-1',
      conversationId: 'conv-1',
      conversationMode: 'auto',
      conversationStatus: 'ai_handling',
      messageId: null,
      isDuplicateEvent: true,
    });

    await AIIntelligenceService.processIncomingMessage({ ...baseMsg, providerEventId: 'evt-1' });

    expect(search).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(sendDirectMessage).not.toHaveBeenCalled();
    expect(db).not.toHaveBeenCalled();
  });

  it('throws without dispatching or persisting anything when msg.connectionId is missing', async () => {
    const { connectionId, ...msgWithoutConnection } = baseMsg;

    await expect(AIIntelligenceService.processIncomingMessage(msgWithoutConnection as UnifiedMessageDTO)).rejects.toThrow(
      'connectionId'
    );

    expect(persist).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe('AIIntelligenceService.processIncomingMessage — issue #74 idempotent AI generation per provider event', () => {
  it('auto mode: a retry whose message insert conflicts on source_provider_event_id creates no job and commits an empty transaction', async () => {
    primeStandardFlow('auto');
    db.mockResolvedValueOnce({ rows: [{ mode: 'auto' }] } as never); // fresh mode re-read
    db.mockResolvedValueOnce({
      rows: [{ workspace_id: 'ws-1', connection_id: 'conn-1', channel: 'telegram', recipient_id: 'tg-user-1' }],
    } as never); // conversations JOIN customers lookup
    db.mockResolvedValueOnce({ rows: [] } as never); // BEGIN
    db.mockResolvedValueOnce({ rows: [] } as never); // AI message insert — ON CONFLICT DO NOTHING, no row returned
    db.mockResolvedValueOnce({ rows: [] } as never); // COMMIT

    await AIIntelligenceService.processIncomingMessage({ ...baseMsg, providerEventId: 'evt-retry-1' });

    expect(createJob).not.toHaveBeenCalled();
    expect(enqueueOutboundJob).not.toHaveBeenCalled();
    expect(db.mock.calls.some(c => c[0] === 'COMMIT')).toBe(true);
    const pendingInsert = db.mock.calls.find(c => typeof c[0] === 'string' && c[0].includes("'ai', $2, 'text', 'pending'"));
    expect(pendingInsert).toBeTruthy();
    expect(pendingInsert![0]).toContain('ON CONFLICT (source_provider_event_id)');
  });

  it('approval mode: a retry whose insert conflicts on source_provider_event_id creates no second draft and skips the audit log', async () => {
    primeStandardFlow('approval');
    db.mockResolvedValueOnce({ rows: [{ mode: 'approval' }] } as never); // fresh mode re-read
    db.mockResolvedValueOnce({ rows: [] } as never); // combined supersede+insert — conflict, no row returned

    await AIIntelligenceService.processIncomingMessage({ ...baseMsg, providerEventId: 'evt-retry-2' });

    expect(audit).not.toHaveBeenCalled();
  });

  it('suggestion mode: a retry whose insert conflicts on source_provider_event_id creates no second suggestion and skips the audit log', async () => {
    primeStandardFlow('suggestion');
    db.mockResolvedValueOnce({ rows: [{ mode: 'suggestion' }] } as never); // fresh mode re-read
    db.mockResolvedValueOnce({ rows: [] } as never); // combined supersede+insert — conflict, no row returned

    await AIIntelligenceService.processIncomingMessage({ ...baseMsg, providerEventId: 'evt-retry-3' });

    expect(audit).not.toHaveBeenCalled();
  });

  it('no-recipient fallback: a retry whose failed-message insert conflicts on source_provider_event_id does not log a second failure', async () => {
    primeStandardFlow('auto');
    db.mockResolvedValueOnce({ rows: [{ mode: 'auto' }] } as never); // fresh mode re-read
    db.mockResolvedValueOnce({ rows: [{ workspace_id: 'ws-1', connection_id: null, channel: 'telegram', recipient_id: null }] } as never); // no dispatchable connection/recipient
    db.mockResolvedValueOnce({ rows: [] } as never); // failed-message insert — conflict, no row returned

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await AIIntelligenceService.processIncomingMessage({ ...baseMsg, providerEventId: 'evt-retry-4' });
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
