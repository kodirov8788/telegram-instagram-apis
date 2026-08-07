import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db', () => ({ query: vi.fn() }));
vi.mock('../../services/ai-intelligence', () => ({
  AIIntelligenceService: { processIncomingMessage: vi.fn() },
}));

import { query } from '../../db';
import { AIIntelligenceService } from '../../services/ai-intelligence';
import { processInboundEvent } from '../processors/inbound';
import { RetryableWorkError } from '../errors';

const db = vi.mocked(query);
const processIncomingMessage = vi.mocked(AIIntelligenceService.processIncomingMessage);

const telegramEvent = {
  id: 'event-1',
  workspace_id: 'ws-1',
  connection_id: 'conn-1',
  provider: 'telegram' as const,
  attempts: 1,
  payload: { update_id: 1, message: { from: { id: 42, first_name: 'Ada' }, text: 'hi' } },
};

beforeEach(() => {
  db.mockReset();
  processIncomingMessage.mockReset();
});

describe('processInboundEvent', () => {
  it('claims the event, normalizes it, and processes it end to end', async () => {
    db.mockResolvedValueOnce({ rows: [telegramEvent] } as never); // claim UPDATE
    processIncomingMessage.mockResolvedValueOnce(undefined);
    db.mockResolvedValueOnce({ rows: [] } as never); // final status UPDATE

    const result = await processInboundEvent('event-1');

    expect(result).toEqual({ outcome: 'processed' });
    expect(processIncomingMessage).toHaveBeenCalledTimes(1);
    const dto = processIncomingMessage.mock.calls[0][0];
    expect(dto.workspaceId).toBe('ws-1');
    expect(dto.connectionId).toBe('conn-1');
    expect(dto.providerEventId).toBe('event-1');
    expect(dto.channelUserIdentifier).toBe('42');
    // final UPDATE marks it processed
    expect(db.mock.calls[1][0]).toContain("status = 'processed'");
  });

  it('does not process when the claim UPDATE matches no row (already claimed/processed elsewhere)', async () => {
    db.mockResolvedValueOnce({ rows: [] } as never);

    const result = await processInboundEvent('event-1');

    expect(result).toEqual({ outcome: 'ignored' });
    expect(processIncomingMessage).not.toHaveBeenCalled();
  });

  it('permanently fails an event whose payload does not normalize to a message', async () => {
    db.mockResolvedValueOnce({
      rows: [{ ...telegramEvent, payload: { update_id: 1 /* no .message */ } }],
    } as never);
    db.mockResolvedValueOnce({ rows: [] } as never); // status UPDATE

    const result = await processInboundEvent('event-1');

    expect(result).toEqual({ outcome: 'permanent_failed' });
    expect(processIncomingMessage).not.toHaveBeenCalled();
    expect(db.mock.calls[1][0]).toContain("status = 'permanent_failed'");
  });

  it('marks retryable_failed and throws RetryableWorkError when processing fails under max attempts', async () => {
    db.mockResolvedValueOnce({ rows: [{ ...telegramEvent, attempts: 3 }] } as never);
    processIncomingMessage.mockRejectedValueOnce(new Error('transient upstream error'));
    db.mockResolvedValueOnce({ rows: [] } as never);

    await expect(processInboundEvent('event-1')).rejects.toThrow(RetryableWorkError);
    expect(db.mock.calls[1][0]).toContain("status = $2");
    expect(db.mock.calls[1][1]).toEqual(['event-1', 'retryable_failed', 'transient upstream error']);
  });

  it('marks permanent_failed without throwing once max attempts is reached', async () => {
    db.mockResolvedValueOnce({ rows: [{ ...telegramEvent, attempts: 8 }] } as never);
    processIncomingMessage.mockRejectedValueOnce(new Error('still failing'));
    db.mockResolvedValueOnce({ rows: [] } as never);

    const result = await processInboundEvent('event-1');

    expect(result).toEqual({ outcome: 'permanent_failed' });
    expect(db.mock.calls[1][1]).toEqual(['event-1', 'permanent_failed', 'still failing']);
  });
});
