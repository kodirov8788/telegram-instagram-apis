export interface UnifiedMessageDTO {
  workspaceId: string;
  channel: 'telegram' | 'instagram';
  channelUserIdentifier: string;
  senderName?: string;
  username?: string;
  content: string;
  messageType: 'text' | 'image' | 'document' | 'voice' | 'location' | 'contact';
  rawPayload: any;
  /** Resolved `channel_connections.id` for the connection this message arrived on, when known. */
  connectionId?: string;
  /** `provider_events.id` this message was normalized from, when processed via the inbound worker. Used for dedup. */
  providerEventId?: string;
}

export class MessageNormalizerService {
  static normalizeTelegramMessage(workspaceId: string, payload: any, connectionId?: string): UnifiedMessageDTO | null {
    const msg = payload.message;
    if (!msg) return null;

    let content = msg.text || '';
    let messageType: UnifiedMessageDTO['messageType'] = 'text';

    if (msg.photo) {
      messageType = 'image';
      content = msg.caption || '[Photo]';
    } else if (msg.voice) {
      messageType = 'voice';
      content = '[Voice Message]';
    } else if (msg.location) {
      messageType = 'location';
      content = `[Location: ${msg.location.latitude}, ${msg.location.longitude}]`;
    } else if (msg.contact) {
      messageType = 'contact';
      content = `[Contact: ${msg.contact.phone_number}]`;
    }

    return {
      workspaceId,
      channel: 'telegram',
      channelUserIdentifier: String(msg.from.id),
      senderName: `${msg.from.first_name || ''} ${msg.from.last_name || ''}`.trim(),
      username: msg.from.username,
      content,
      messageType,
      rawPayload: payload,
      connectionId,
    };
  }

  static normalizeInstagramMessage(
    workspaceId: string,
    messagingEntry: any,
    connectionId?: string
  ): UnifiedMessageDTO | null {
    const msg = messagingEntry.message;
    if (!msg) return null;

    let content = msg.text || '';
    let messageType: UnifiedMessageDTO['messageType'] = 'text';

    if (msg.attachments && msg.attachments.length > 0) {
      const att = msg.attachments[0];
      if (att.type === 'image') messageType = 'image';
      content = att.payload?.url || '[Attachment]';
    }

    return {
      workspaceId,
      channel: 'instagram',
      channelUserIdentifier: messagingEntry.sender.id,
      content,
      messageType,
      rawPayload: messagingEntry,
      connectionId,
    };
  }
}
