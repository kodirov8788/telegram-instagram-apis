import { UnifiedMessageDTO } from './message-queue';
import { AIClassifierService } from './ai-classifier';
import { KnowledgeBaseService } from './knowledge-base';
import { TelegramService } from './telegram';
import { InstagramService } from './instagram';
import { AuditLogService } from './audit-log';
import pool, { query } from '../db';
import { getConnectionSecret } from './connection-secret-loader';

export class AIIntelligenceService {
  static async processIncomingMessage(msg: UnifiedMessageDTO) {
    console.log(`Processing incoming message from ${msg.channel}: "${msg.content}"`);

    // 1. Classify language, intent, sentiment, and extract lead info
    const classification = await AIClassifierService.classifyMessage(msg.content);

    // 2. Check or upsert Customer & Conversation record
    const customerRes = await query(
      `INSERT INTO customers (workspace_id, full_name, ${msg.channel}_username, ${msg.channel}_id, preferred_language, connection_id, provider_user_id, last_contact_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT DO UPDATE SET last_contact_at = NOW()
       RETURNING id`,
      [
        msg.workspaceId,
        msg.senderName || 'Customer',
        msg.username,
        msg.channelUserIdentifier,
        classification.language,
        msg.connectionId || null,
        msg.connectionId ? msg.channelUserIdentifier : null,
      ]
    );
    const customerId = customerRes.rows[0]?.id;

    // Check active conversation status
    const convRes = await query(
      `SELECT * FROM conversations WHERE workspace_id = $1 AND customer_id = $2 AND channel = $3 ORDER BY last_message_at DESC LIMIT 1`,
      [msg.workspaceId, customerId, msg.channel]
    );

    let conversation = convRes.rows[0];
    if (!conversation) {
      const newConv = await query(
        `INSERT INTO conversations (workspace_id, customer_id, channel, connection_id, status, mode, detected_language, detected_intent, sentiment)
         VALUES ($1, $2, $3, $4, 'new', 'auto', $5, $6, $7)
         RETURNING *`,
        [
          msg.workspaceId,
          customerId,
          msg.channel,
          msg.connectionId || null,
          classification.language,
          classification.intent,
          classification.sentiment,
        ]
      );
      conversation = newConv.rows[0];
    }

    // Save inbound message. When this message came through the inbound
    // worker (msg.providerEventId set), the partial unique index on
    // messages.provider_event_id makes this insert a no-op for a
    // redelivered/re-processed event instead of creating a duplicate
    // customer-facing message; when absent (direct callers, tests), this
    // behaves exactly as before.
    const inboundInsert = await query(
      `INSERT INTO messages (conversation_id, sender, content, message_type, delivery_status, provider_event_id)
       VALUES ($1, 'customer', $2, $3, 'delivered', $4)
       ON CONFLICT (provider_event_id) WHERE provider_event_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [conversation.id, msg.content, msg.messageType, msg.providerEventId || null]
    );
    if (msg.providerEventId && inboundInsert.rowCount === 0) {
      // Already fully processed this exact provider event; nothing further to do.
      return;
    }

    // 3. Evaluate Escalation Triggers (Human Handoff)
    const isEscalationTrigger = 
      classification.intent === 'human_agent_request' ||
      classification.intent === 'complaint' ||
      classification.intent === 'refund_request' ||
      classification.sentiment === 'angry' ||
      classification.confidenceScore < 0.6;

    if (isEscalationTrigger || conversation.status === 'human_handling' || conversation.mode === 'human') {
      console.log(`Conversation ${conversation.id} flagged for human operator attention.`);
      await query(
        `UPDATE conversations 
         SET status = 'human_attention_required', mode = 'human', detected_intent = $1, sentiment = $2, last_message_at = NOW()
         WHERE id = $3`,
        [classification.intent, classification.sentiment, conversation.id]
      );
      
      // Auto notification banner message
      const handoffNotice = classification.language === 'ru' 
        ? "Ваш запрос передан оператору. Наш сотрудник ответит вам в ближайшее время."
        : classification.language === 'en'
        ? "Your request has been transferred to a human operator. We will respond shortly."
        : "Sizning so'rovingiz operatorga uzatildi. Xodimimiz tez orada javob beradi.";

      await this.dispatchOutboundMessage(msg, handoffNotice);
      return;
    }

    // 4. RAG Retrieval from Knowledge Base
    const knowledgeDocs = await KnowledgeBaseService.searchRelevantKnowledge(
      msg.workspaceId,
      msg.content,
      classification.language
    );

    const contextText = knowledgeDocs.map(d => `[${d.title}]: ${d.content}`).join('\n\n');

    // 5. Synthesize Response with Prompt Guardrails
    let aiReplyText = "";
    if (knowledgeDocs.length > 0) {
      aiReplyText = `[Knowledge Base Answer]\n${knowledgeDocs[0].content}`;
    } else {
      aiReplyText = classification.language === 'ru'
        ? "К сожалению, у меня нет точной информации по вашему вопросу. Я передам запрос менеджеру."
        : classification.language === 'en'
        ? "I apologize, but I don't have exact information regarding your question. I will forward this to our manager."
        : "Afsuski, bu savol bo'yicha aniq ma'lumotga ega emasman. So'rovingizni menejerga yo'naltiraman.";
    }

    // 6. Route by control mode (ISSUE-11). Re-read mode fresh here rather
    // than trusting the `conversation` object fetched at step 2 — the AI
    // classification, knowledge retrieval, and response synthesis above can
    // take seconds, long enough for a human operator to change the mode
    // (e.g. take the conversation over) mid-flight. Deciding on a stale
    // value could send an AI reply after a human already took control.
    const modeRes = await query(`SELECT mode FROM conversations WHERE id = $1`, [conversation.id]);
    const currentMode: 'auto' | 'approval' | 'suggestion' | 'human' | undefined = modeRes.rows[0]?.mode;

    if (currentMode === 'human') {
      // A human took over while this reply was being generated. Drop it —
      // sending it now would contradict the handoff that already happened.
      return;
    }

    if (currentMode === 'approval' || currentMode === 'suggestion') {
      // Only the newest AI-generated message per conversation is ever
      // actionable: superseding older pending drafts/suggestions here means
      // an operator can never approve or act on stale AI output once a
      // newer customer message has produced a newer reply. The supersede
      // and the new-draft insert are one CTE statement, not two separate
      // query() calls — Postgres executes a WITH...INSERT atomically, so a
      // second concurrent processIncomingMessage run on the same
      // conversation can't interleave between them and leave two "live"
      // drafts.
      const draftStatus = currentMode === 'approval' ? 'pending_approval' : 'suggested';
      const inserted = await query(
        `WITH superseded AS (
           UPDATE messages SET delivery_status = 'stale'
           WHERE conversation_id = $1 AND delivery_status IN ('pending_approval', 'suggested')
         )
         INSERT INTO messages (conversation_id, sender, content, message_type, delivery_status, ai_confidence)
         VALUES ($1, 'ai', $2, 'text', $3, $4)
         RETURNING id`,
        [conversation.id, aiReplyText, draftStatus, classification.confidenceScore]
      );

      await AuditLogService.logEvent({
        workspaceId: msg.workspaceId,
        actorType: 'ai_agent',
        action: currentMode === 'approval' ? 'message.draft_created' : 'message.suggestion_created',
        entityType: 'message',
        entityId: inserted.rows[0]?.id,
        newValue: { conversationId: conversation.id, deliveryStatus: draftStatus },
      });
      return;
    }

    // 'auto': insert as 'pending' and only flip to 'sent' after dispatch
    // actually succeeds — not before. Marking it 'sent' first (the prior
    // behavior) meant a dispatch failure left a permanently mislabeled row
    // that claims delivery which never happened, with nothing surfacing the
    // failure. This also can't be silently retried today (the
    // provider_event_id dedup at the top of this function short-circuits
    // before reaching this code on any redelivery of the same inbound
    // event), so on failure this records 'failed' rather than leaving the
    // wrong status — automatic redispatch is future work, tracked with the
    // outbound-jobs queue explicitly deferred in ISSUE-07's PR.
    const aiInsert = await query(
      `INSERT INTO messages (conversation_id, sender, content, message_type, delivery_status, ai_confidence)
       VALUES ($1, 'ai', $2, 'text', 'pending', $3)
       RETURNING id`,
      [conversation.id, aiReplyText, classification.confidenceScore]
    );
    try {
      await this.dispatchOutboundMessage(msg, aiReplyText);
      await query(`UPDATE messages SET delivery_status = 'sent' WHERE id = $1`, [aiInsert.rows[0]?.id]);
    } catch (error) {
      await query(`UPDATE messages SET delivery_status = 'failed' WHERE id = $1`, [aiInsert.rows[0]?.id]);
      throw error;
    }
  }

  /** Public: also called by the approve-draft API route once a pending_approval message is approved. */
  static async dispatchOutboundMessage(msg: UnifiedMessageDTO, text: string) {
    if (msg.channel === 'telegram') {
      const token = await this.resolveTelegramBotToken(msg.connectionId, msg.workspaceId);
      if (token) {
        const tg = new TelegramService(token);
        await tg.sendMessage(msg.channelUserIdentifier, text);
      }
    } else if (msg.channel === 'instagram') {
      const token = await this.resolveInstagramAccessToken(msg.connectionId, msg.workspaceId);
      if (token) {
        const ig = new InstagramService(token);
        await ig.sendDirectMessage(msg.channelUserIdentifier, text);
      }
    }
  }

  /**
   * Prefers the workspace's own connection-scoped Instagram page access
   * token (via `getConnectionSecret`, Vault-backed with a transitional
   * plaintext fallback — see migration 014) over the single global
   * `INSTAGRAM_PAGE_ACCESS_TOKEN` env var, so each workspace sends from its
   * own connected account. Falls back to the env var only when no
   * connection-scoped credential is available, to avoid a hard regression
   * for any existing manual/test usage that never went through a resolved
   * connection.
   */
  private static async resolveInstagramAccessToken(connectionId?: string, workspaceId?: string): Promise<string> {
    if (connectionId && workspaceId) {
      const secret = await getConnectionSecret(connectionId, workspaceId);
      const token = secret?.pageAccessToken;
      if (typeof token === 'string' && token) return token;
    }
    return process.env.INSTAGRAM_PAGE_ACCESS_TOKEN || '';
  }

  /**
   * Mirrors `resolveInstagramAccessToken`'s fallback shape for Telegram:
   * prefers a connection-scoped bot token, falls back to the global
   * `TELEGRAM_BOT_TOKEN` env var when the connection has none.
   */
  private static async resolveTelegramBotToken(connectionId?: string, workspaceId?: string): Promise<string> {
    if (connectionId && workspaceId) {
      const secret = await getConnectionSecret(connectionId, workspaceId);
      const token = secret?.botToken;
      if (typeof token === 'string' && token) return token;
    }
    return process.env.TELEGRAM_BOT_TOKEN || '';
  }
}
