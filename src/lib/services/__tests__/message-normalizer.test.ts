import { describe, expect, it } from 'vitest';
import { MessageNormalizerService } from '../message-queue';

describe('MessageNormalizerService', () => {
  describe('normalizeTelegramMessage', () => {
    it('normalizes a Telegram text message', () => {
      const payload = {
        update_id: 42,
        message: {
          message_id: 7,
          from: {
            id: 12345,
            first_name: 'Ada',
            last_name: 'Lovelace',
            username: 'ada',
          },
          text: 'Hello from Telegram',
        },
      };

      expect(MessageNormalizerService.normalizeTelegramMessage('workspace-1', payload)).toEqual({
        workspaceId: 'workspace-1',
        channel: 'telegram',
        channelUserIdentifier: '12345',
        senderName: 'Ada Lovelace',
        username: 'ada',
        content: 'Hello from Telegram',
        messageType: 'text',
        rawPayload: payload,
      });
    });

    it('normalizes a Telegram photo attachment with its caption', () => {
      const payload = {
        message: {
          from: { id: 99, first_name: 'Grace' },
          photo: [{ file_id: 'small' }, { file_id: 'large' }],
          caption: 'Architecture sketch',
        },
      };

      const normalized = MessageNormalizerService.normalizeTelegramMessage('workspace-1', payload);

      expect(normalized).toMatchObject({
        channel: 'telegram',
        channelUserIdentifier: '99',
        senderName: 'Grace',
        content: 'Architecture sketch',
        messageType: 'image',
      });
    });

    it('returns null for a Telegram payload without a message', () => {
      expect(MessageNormalizerService.normalizeTelegramMessage('workspace-1', { update_id: 42 })).toBeNull();
    });
  });

  describe('normalizeInstagramMessage', () => {
    it('normalizes an Instagram text message', () => {
      const messagingEntry = {
        sender: { id: 'ig-user-123' },
        recipient: { id: 'ig-page-456' },
        timestamp: 1710000000000,
        message: { mid: 'message-1', text: 'Hello from Instagram' },
      };

      expect(MessageNormalizerService.normalizeInstagramMessage('workspace-2', messagingEntry)).toEqual({
        workspaceId: 'workspace-2',
        channel: 'instagram',
        channelUserIdentifier: 'ig-user-123',
        content: 'Hello from Instagram',
        messageType: 'text',
        rawPayload: messagingEntry,
      });
    });

    it('normalizes the first Instagram image attachment', () => {
      const messagingEntry = {
        sender: { id: 'ig-user-789' },
        message: {
          mid: 'message-2',
          attachments: [
            { type: 'image', payload: { url: 'https://example.com/photo.jpg' } },
          ],
        },
      };

      const normalized = MessageNormalizerService.normalizeInstagramMessage('workspace-2', messagingEntry);

      expect(normalized).toMatchObject({
        channel: 'instagram',
        channelUserIdentifier: 'ig-user-789',
        content: 'https://example.com/photo.jpg',
        messageType: 'image',
      });
    });

    it('uses a fallback for an Instagram attachment without a URL', () => {
      const messagingEntry = {
        sender: { id: 'ig-user-789' },
        message: { attachments: [{ type: 'file', payload: {} }] },
      };

      expect(MessageNormalizerService.normalizeInstagramMessage('workspace-2', messagingEntry)).toMatchObject({
        content: '[Attachment]',
        messageType: 'text',
      });
    });

    it('returns null for an Instagram entry without a message', () => {
      expect(
        MessageNormalizerService.normalizeInstagramMessage('workspace-2', {
          sender: { id: 'ig-user-123' },
        }),
      ).toBeNull();
    });
  });
});
