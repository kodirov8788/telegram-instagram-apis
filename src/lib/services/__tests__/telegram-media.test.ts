import { describe, it, expect } from 'vitest';
import { TelegramMediaHandler } from '../telegram-media';

describe('TelegramMediaHandler', () => {
  it('parses text messages correctly', () => {
    const parsed = TelegramMediaHandler.parseIncomingMedia({
      message_id: 1,
      from: { id: 1, is_bot: false, first_name: 'John' },
      chat: { id: 100, type: 'private' },
      date: 1600000000,
      text: 'Hello world',
    });
    expect(parsed).toEqual({ type: 'text', content: 'Hello world' });
  });

  it('parses photo messages with caption correctly', () => {
    const parsed = TelegramMediaHandler.parseIncomingMedia({
      message_id: 2,
      from: { id: 1, is_bot: false, first_name: 'John' },
      chat: { id: 100, type: 'private' },
      date: 1600000000,
      photo: [
        { file_id: 'small_id', width: 100, height: 100 },
        { file_id: 'large_id', width: 800, height: 600 },
      ],
      caption: 'Sample photo caption',
    });
    expect(parsed).toEqual({
      type: 'photo',
      content: 'Sample photo caption',
      metadata: { file_id: 'large_id', width: 800, height: 600 },
    });
  });

  it('parses photo messages without caption using fallback', () => {
    const parsed = TelegramMediaHandler.parseIncomingMedia({
      message_id: 3,
      from: { id: 1, is_bot: false, first_name: 'John' },
      chat: { id: 100, type: 'private' },
      date: 1600000000,
      photo: [{ file_id: 'photo_id', width: 500, height: 500 }],
    });
    expect(parsed).toEqual({
      type: 'photo',
      content: '[Photo Attachment]',
      metadata: { file_id: 'photo_id', width: 500, height: 500 },
    });
  });

  it('parses voice messages correctly', () => {
    const parsed = TelegramMediaHandler.parseIncomingMedia({
      message_id: 4,
      from: { id: 1, is_bot: false, first_name: 'John' },
      chat: { id: 100, type: 'private' },
      date: 1600000000,
      voice: { file_id: 'voice_id', duration: 15 },
    });
    expect(parsed).toEqual({
      type: 'voice',
      content: '[Voice Message Received - Processing Speech-To-Text]',
      metadata: { file_id: 'voice_id', duration: 15 },
    });
  });

  it('parses location messages correctly', () => {
    const parsed = TelegramMediaHandler.parseIncomingMedia({
      message_id: 5,
      from: { id: 1, is_bot: false, first_name: 'John' },
      chat: { id: 100, type: 'private' },
      date: 1600000000,
      location: { latitude: 35.6762, longitude: 139.6503 },
    });
    expect(parsed).toEqual({
      type: 'location',
      content: 'Latitude: 35.6762, Longitude: 139.6503',
      metadata: { latitude: 35.6762, longitude: 139.6503 },
    });
  });

  it('parses contact messages correctly', () => {
    const parsed = TelegramMediaHandler.parseIncomingMedia({
      message_id: 6,
      from: { id: 1, is_bot: false, first_name: 'John' },
      chat: { id: 100, type: 'private' },
      date: 1600000000,
      contact: { phone_number: '+123456789', first_name: 'Jane', last_name: 'Doe' },
    });
    expect(parsed).toEqual({
      type: 'contact',
      content: 'Phone: +123456789, Name: Jane Doe',
      metadata: { phone_number: '+123456789', first_name: 'Jane', last_name: 'Doe' },
    });
  });

  it('parses unsupported media correctly', () => {
    const parsed = TelegramMediaHandler.parseIncomingMedia({
      message_id: 7,
      from: { id: 1, is_bot: false, first_name: 'John' },
      chat: { id: 100, type: 'private' },
      date: 1600000000,
    });
    expect(parsed).toEqual({ type: 'text', content: '[Unsupported Media Type]' });
  });
});
