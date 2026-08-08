import { query } from '../db';

export type InboundProvider = 'telegram' | 'instagram';

export interface InboundMessageInput {
  connectionId: string;
  provider: InboundProvider;
  providerUserId: string;
  content: string;
  messageType: string;
  fullName?: string;
  username?: string;
  detectedLanguage?: string;
  detectedIntent?: string;
  sentiment?: string;
  providerEventId?: string;
}

export interface PersistedInboundMessage {
  customerId: string;
  conversationId: string;
  conversationMode: 'auto' | 'approval' | 'suggestion' | 'human';
  conversationStatus: string;
  messageId: string | null;
  isDuplicateEvent: boolean;
}

/**
 * Thin wrapper around the `persist_inbound_message` SECURITY DEFINER
 * function (migration 012), which atomically performs the customer upsert,
 * active-conversation resolve/create, and inbound-message insert that
 * `AIIntelligenceService.processIncomingMessage` previously ran as three
 * separate statements. The only trust anchor is `connectionId` — the
 * function derives workspace_id server-side from the real, active
 * `channel_connections` row; no workspace_id is ever accepted here.
 */
export class InboundPersistenceService {
  static async persist(input: InboundMessageInput): Promise<PersistedInboundMessage> {
    if (!input.connectionId || !input.providerUserId?.trim()) {
      throw new Error('connectionId and providerUserId are required');
    }
    if (!input.content) {
      throw new Error('content is required');
    }
    const result = await query(
      `SELECT
         out_customer_id AS customer_id,
         out_conversation_id AS conversation_id,
         out_conversation_mode AS conversation_mode,
         out_conversation_status AS conversation_status,
         out_message_id AS message_id,
         out_is_duplicate_event AS is_duplicate_event
       FROM persist_inbound_message($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        input.connectionId,
        input.provider,
        input.providerUserId.trim(),
        input.content,
        input.messageType || 'text',
        input.fullName ?? null,
        input.username ?? null,
        input.detectedLanguage ?? null,
        input.detectedIntent ?? null,
        input.sentiment ?? null,
        input.providerEventId ?? null,
      ]
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error('persist_inbound_message returned no result');
    }
    return {
      customerId: row.customer_id,
      conversationId: row.conversation_id,
      conversationMode: row.conversation_mode,
      conversationStatus: row.conversation_status,
      messageId: row.message_id ?? null,
      isDuplicateEvent: row.is_duplicate_event === true,
    };
  }
}
