import { TelegramWebhookMessage } from './telegram';

export interface ParsedTelegramMedia {
  type: 'text' | 'voice' | 'photo' | 'document' | 'location' | 'contact';
  content: string;
  attachmentUrl?: string;
  metadata?: any;
}

export class TelegramMediaHandler {
  static parseIncomingMedia(msg: NonNullable<TelegramWebhookMessage['message']>): ParsedTelegramMedia {
    if (msg.text) {
      return { type: 'text', content: msg.text };
    }

    if (msg.photo && msg.photo.length > 0) {
      // Get highest resolution photo (last in array)
      const largestPhoto = msg.photo[msg.photo.length - 1];
      return {
        type: 'photo',
        content: msg.caption || '[Photo Attachment]',
        metadata: { file_id: largestPhoto.file_id, width: largestPhoto.width, height: largestPhoto.height },
      };
    }

    if (msg.voice) {
      return {
        type: 'voice',
        content: '[Voice Message Received - Processing Speech-To-Text]',
        metadata: { file_id: msg.voice.file_id, duration: msg.voice.duration },
      };
    }

    if (msg.location) {
      return {
        type: 'location',
        content: `Latitude: ${msg.location.latitude}, Longitude: ${msg.location.longitude}`,
        metadata: msg.location,
      };
    }

    if (msg.contact) {
      return {
        type: 'contact',
        content: `Phone: ${msg.contact.phone_number}, Name: ${msg.contact.first_name} ${msg.contact.last_name || ''}`.trim(),
        metadata: msg.contact,
      };
    }

    return { type: 'text', content: '[Unsupported Media Type]' };
  }
}
