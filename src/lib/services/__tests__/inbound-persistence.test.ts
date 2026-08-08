import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db', () => ({ query: vi.fn() }));

import { query } from '../../db';
import { InboundPersistenceService, InboundMessageInput } from '../inbound-persistence';

const db = vi.mocked(query);

const baseInput: InboundMessageInput = {
  connectionId: 'conn-1',
  provider: 'telegram',
  providerUserId: 'tg-user-1',
  content: 'hello',
  messageType: 'text',
  fullName: 'Jane Doe',
  username: 'janedoe',
  detectedLanguage: 'en',
  detectedIntent: 'general_inquiry',
  sentiment: 'neutral',
};

beforeEach(() => {
  db.mockReset();
});

describe('InboundPersistenceService.persist', () => {
  it('calls persist_inbound_message with the expected SQL and positional params', async () => {
    db.mockResolvedValueOnce({
      rows: [
        {
          customer_id: 'cust-1',
          conversation_id: 'conv-1',
          conversation_mode: 'auto',
          conversation_status: 'new',
          message_id: 'msg-1',
          is_duplicate_event: false,
        },
      ],
    } as never);

    const result = await InboundPersistenceService.persist({ ...baseInput, providerEventId: 'evt-1' });

    expect(db).toHaveBeenCalledTimes(1);
    const [sql, params] = db.mock.calls[0];
    expect(sql).toContain('FROM persist_inbound_message($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)');
    expect(params).toEqual([
      'conn-1',
      'telegram',
      'tg-user-1',
      'hello',
      'text',
      'Jane Doe',
      'janedoe',
      'en',
      'general_inquiry',
      'neutral',
      'evt-1',
    ]);

    expect(result).toEqual({
      customerId: 'cust-1',
      conversationId: 'conv-1',
      conversationMode: 'auto',
      conversationStatus: 'new',
      messageId: 'msg-1',
      isDuplicateEvent: false,
    });
  });

  it('defaults optional fields to null when not provided', async () => {
    db.mockResolvedValueOnce({
      rows: [
        {
          customer_id: 'cust-1',
          conversation_id: 'conv-1',
          conversation_mode: 'auto',
          conversation_status: 'new',
          message_id: 'msg-1',
          is_duplicate_event: false,
        },
      ],
    } as never);

    await InboundPersistenceService.persist({
      connectionId: 'conn-1',
      provider: 'instagram',
      providerUserId: 'ig-user-1',
      content: 'hi',
      messageType: 'text',
    });

    const [, params] = db.mock.calls[0];
    expect(params).toEqual(['conn-1', 'instagram', 'ig-user-1', 'hi', 'text', null, null, null, null, null, null]);
  });

  it('signals duplicate events via isDuplicateEvent with a null messageId, without throwing', async () => {
    db.mockResolvedValueOnce({
      rows: [
        {
          customer_id: 'cust-1',
          conversation_id: 'conv-1',
          conversation_mode: 'auto',
          conversation_status: 'ai_handling',
          message_id: null,
          is_duplicate_event: true,
        },
      ],
    } as never);

    const result = await InboundPersistenceService.persist({ ...baseInput, providerEventId: 'evt-dup' });

    expect(result.isDuplicateEvent).toBe(true);
    expect(result.messageId).toBeNull();
  });

  it('throws when connectionId is missing', async () => {
    await expect(
      InboundPersistenceService.persist({ ...baseInput, connectionId: '' })
    ).rejects.toThrow('connectionId and providerUserId are required');
    expect(db).not.toHaveBeenCalled();
  });

  it('throws when providerUserId is blank', async () => {
    await expect(
      InboundPersistenceService.persist({ ...baseInput, providerUserId: '   ' })
    ).rejects.toThrow('connectionId and providerUserId are required');
    expect(db).not.toHaveBeenCalled();
  });

  it('throws when content is empty', async () => {
    await expect(InboundPersistenceService.persist({ ...baseInput, content: '' })).rejects.toThrow(
      'content is required'
    );
    expect(db).not.toHaveBeenCalled();
  });

  it('throws when the database returns no rows (unexpected empty result)', async () => {
    db.mockResolvedValueOnce({ rows: [] } as never);
    await expect(InboundPersistenceService.persist(baseInput)).rejects.toThrow(
      'persist_inbound_message returned no result'
    );
  });
});
