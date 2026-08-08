import { beforeEach, describe, expect, it, vi } from 'vitest';

// Focused test for the issue #33 lead-extraction call site added to
// processIncomingMessage. Kept in its own file (rather than editing
// ai-intelligence.test.ts) to minimize merge-conflict surface with the
// sibling inbound-retry-idempotency track also touching that file.
const dbMocks = vi.hoisted(() => ({ query: vi.fn(), connect: vi.fn() }));
vi.mock('../../db', () => ({ query: dbMocks.query, default: { connect: dbMocks.connect } }));
vi.mock('../ai-classifier', () => ({ AIClassifierService: { classifyMessage: vi.fn() } }));
vi.mock('../knowledge-base', () => ({ KnowledgeBaseService: { searchRelevantKnowledge: vi.fn() } }));
vi.mock('../audit-log', () => ({ AuditLogService: { logEvent: vi.fn() } }));
vi.mock('../inbound-persistence', () => ({ InboundPersistenceService: { persist: vi.fn() } }));
vi.mock('../lead-extractor', () => ({ LeadExtractorService: { extractAndSaveLead: vi.fn() } }));

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
  sendDirectMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
}));
vi.mock('../telegram', () => ({ TelegramService: class { sendMessage = mocks.sendMessage; } }));
vi.mock('../instagram', () => ({ InstagramService: class { sendDirectMessage = mocks.sendDirectMessage; } }));

vi.mock('../outbound-jobs', () => ({
  createJob: vi.fn().mockResolvedValue({ id: 'job-1' }),
  enqueueOutboundJob: vi.fn().mockResolvedValue(undefined),
  DuplicateActiveJobError: class DuplicateActiveJobError extends Error {},
}));

import { query } from '../../db';
import { AIClassifierService } from '../ai-classifier';
import { KnowledgeBaseService } from '../knowledge-base';
import { InboundPersistenceService } from '../inbound-persistence';
import { LeadExtractorService } from '../lead-extractor';
import { AIIntelligenceService } from '../ai-intelligence';
import type { UnifiedMessageDTO } from '../message-queue';

const db = vi.mocked(query);
const connect = vi.mocked(dbMocks.connect);
const classify = vi.mocked(AIClassifierService.classifyMessage);
const search = vi.mocked(KnowledgeBaseService.searchRelevantKnowledge);
const persist = vi.mocked(InboundPersistenceService.persist);
const extractLead = vi.mocked(LeadExtractorService.extractAndSaveLead);

const baseMsg: UnifiedMessageDTO = {
  workspaceId: 'ws-1',
  channel: 'telegram',
  channelUserIdentifier: 'tg-user-1',
  content: 'I want a sofa, budget $500',
  messageType: 'text',
  rawPayload: {},
  connectionId: 'conn-1',
};

beforeEach(() => {
  db.mockReset();
  connect.mockReset();
  connect.mockResolvedValue({ query: db, release: vi.fn() });
  classify.mockReset();
  search.mockReset().mockResolvedValue([] as never);
  persist.mockReset();
  extractLead.mockReset().mockResolvedValue({ id: 'lead-1' } as never);
  db.mockResolvedValue({ rows: [{ mode: 'human' }] } as never); // fresh mode re-read: skip downstream reply logic
});

function primeStandardFlow() {
  persist.mockResolvedValueOnce({
    customerId: 'cust-1',
    conversationId: 'conv-1',
    conversationMode: 'human' as never,
    conversationStatus: 'human_handling',
    messageId: 'msg-inbound-1',
    isDuplicateEvent: false,
  });
}

describe('AIIntelligenceService.processIncomingMessage — lead extraction (issue #33)', () => {
  it('calls LeadExtractorService with extracted product/budget when present', async () => {
    primeStandardFlow();
    classify.mockResolvedValue({
      language: 'en', intent: 'price_inquiry', sentiment: 'neutral', confidenceScore: 0.9,
      extractedLeadInfo: { name: 'Jane', phone: '+1', product: 'sofa', budget: '$500' },
    } as never);

    await AIIntelligenceService.processIncomingMessage(baseMsg);

    expect(extractLead).toHaveBeenCalledWith({
      connectionId: 'conn-1',
      customerId: 'cust-1',
      conversationId: 'conv-1',
      requestedProductOrService: 'sofa',
      budget: '$500',
    });
  });

  it('does not call LeadExtractorService when no product/budget was extracted', async () => {
    primeStandardFlow();
    classify.mockResolvedValue({
      language: 'en', intent: 'general_inquiry', sentiment: 'neutral', confidenceScore: 0.9,
    } as never);

    await AIIntelligenceService.processIncomingMessage(baseMsg);

    expect(extractLead).not.toHaveBeenCalled();
  });

  it('does not call LeadExtractorService for a duplicate provider event', async () => {
    persist.mockResolvedValueOnce({
      customerId: 'cust-1', conversationId: 'conv-1', conversationMode: 'human',
      conversationStatus: 'human_handling', messageId: null, isDuplicateEvent: true,
    });
    classify.mockResolvedValue({
      language: 'en', intent: 'general_inquiry', sentiment: 'neutral', confidenceScore: 0.9,
      extractedLeadInfo: { product: 'sofa' },
    } as never);

    await AIIntelligenceService.processIncomingMessage({ ...baseMsg, providerEventId: 'evt-1' });

    expect(extractLead).not.toHaveBeenCalled();
  });

  it('does not let a lead-extraction failure block message processing', async () => {
    primeStandardFlow();
    classify.mockResolvedValue({
      language: 'en', intent: 'general_inquiry', sentiment: 'neutral', confidenceScore: 0.9,
      extractedLeadInfo: { product: 'sofa' },
    } as never);
    extractLead.mockRejectedValueOnce(new Error('db down'));

    await expect(AIIntelligenceService.processIncomingMessage(baseMsg)).resolves.not.toThrow();
  });
});
