import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db', () => ({ query: vi.fn(), default: { connect: vi.fn() } }));
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

import { query } from '../../db';
import { AIClassifierService } from '../ai-classifier';
import { KnowledgeBaseService } from '../knowledge-base';
import { AuditLogService } from '../audit-log';
import { InboundPersistenceService } from '../inbound-persistence';
import { AIIntelligenceService } from '../ai-intelligence';
import type { UnifiedMessageDTO } from '../message-queue';

const db = vi.mocked(query);
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
  classify.mockReset();
  search.mockReset();
  audit.mockReset();
  persist.mockReset();
  sendMessage.mockClear();
  sendDirectMessage.mockClear();
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
  it('auto mode: inserts pending, dispatches, then flips to sent only after dispatch succeeds', async () => {
    primeStandardFlow('auto');
    db.mockResolvedValueOnce({ rows: [{ mode: 'auto' }] } as never); // fresh mode re-read
    db.mockResolvedValueOnce({ rows: [{ id: 'ai-msg-1' }] } as never); // AI message insert (status: pending)
    db.mockResolvedValueOnce({ rows: [] } as never); // UPDATE -> 'sent' after successful dispatch

    await AIIntelligenceService.processIncomingMessage(baseMsg);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const pendingInsert = db.mock.calls.find(c => typeof c[0] === 'string' && c[0].includes("'ai', $2, 'text', 'pending'"));
    expect(pendingInsert).toBeTruthy();
    const sentUpdate = db.mock.calls.find(c => typeof c[0] === 'string' && c[0].includes("delivery_status = 'sent'"));
    expect(sentUpdate).toBeTruthy();
    expect(sentUpdate![1]).toEqual(['ai-msg-1']);
  });

  it('auto mode: marks the message failed (not sent) if dispatch throws, and rethrows', async () => {
    primeStandardFlow('auto');
    db.mockResolvedValueOnce({ rows: [{ mode: 'auto' }] } as never);
    db.mockResolvedValueOnce({ rows: [{ id: 'ai-msg-2' }] } as never); // AI message insert (status: pending)
    db.mockResolvedValueOnce({ rows: [] } as never); // UPDATE -> 'failed'
    sendMessage.mockRejectedValueOnce(new Error('telegram down'));

    await expect(AIIntelligenceService.processIncomingMessage(baseMsg)).rejects.toThrow('telegram down');

    const failedUpdate = db.mock.calls.find(c => typeof c[0] === 'string' && c[0].includes("delivery_status = 'failed'"));
    expect(failedUpdate).toBeTruthy();
    expect(failedUpdate![1]).toEqual(['ai-msg-2']);
    const sentUpdate = db.mock.calls.find(c => typeof c[0] === 'string' && c[0].includes("delivery_status = 'sent'"));
    expect(sentUpdate).toBeFalsy();
  });

  it('approval mode: creates a pending_approval draft in one atomic statement and never dispatches', async () => {
    primeStandardFlow('approval');
    db.mockResolvedValueOnce({ rows: [{ mode: 'approval' }] } as never); // fresh mode re-read
    db.mockResolvedValueOnce({ rows: [{ id: 'draft-1' }] } as never); // combined supersede+insert

    await AIIntelligenceService.processIncomingMessage(baseMsg);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(sendDirectMessage).not.toHaveBeenCalled();
    const draftInsert = db.mock.calls.find(c => typeof c[0] === 'string' && c[0].includes('WITH superseded AS'));
    expect(draftInsert).toBeTruthy();
    expect(draftInsert![0]).toContain("delivery_status = 'stale'");
    expect(draftInsert![0]).toContain("IN ('pending_approval', 'suggested')");
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'message.draft_created', entityId: 'draft-1' }));
  });

  it('suggestion mode: creates a suggested message and never dispatches', async () => {
    primeStandardFlow('suggestion');
    db.mockResolvedValueOnce({ rows: [{ mode: 'suggestion' }] } as never);
    db.mockResolvedValueOnce({ rows: [{ id: 'suggestion-1' }] } as never); // combined supersede+insert

    await AIIntelligenceService.processIncomingMessage(baseMsg);

    expect(sendMessage).not.toHaveBeenCalled();
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
