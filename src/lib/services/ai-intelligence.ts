import { UnifiedMessageDTO } from './message-queue';
import { AIClassifierService } from './ai-classifier';
import { KnowledgeBaseService } from './knowledge-base';
import { TelegramService } from './telegram';
import { InstagramService } from './instagram';
import { AuditLogService } from './audit-log';
import { InboundPersistenceService } from './inbound-persistence';
import { LeadExtractorService } from './lead-extractor';
import pool, { query } from '../db';
import { getConnectionSecret } from './connection-secret-loader';
import { createJob, enqueueOutboundJob } from './outbound-jobs';

export class AIIntelligenceService {
  static async processIncomingMessage(msg: UnifiedMessageDTO) {
    console.log(`Processing incoming message from ${msg.channel}: "${msg.content}"`);

    // 1. Classify language, intent, sentiment, and extract lead info
    const classification = await AIClassifierService.classifyMessage(msg.content);

    // 2. Atomically upsert the customer, resolve-or-create the active
    // conversation, and insert the inbound message (migration 012's
    // persist_inbound_message). This replaces three separate query() calls
    // that previously left a real interleaving window between the customer
    // upsert and the conversation lookup. The only trust anchor is
    // msg.connectionId — the function derives workspace_id server-side from
    // the real, active channel_connections row; msg.workspaceId is not
    // trusted for this write.
    if (!msg.connectionId) {
      throw new Error('processIncomingMessage requires msg.connectionId to resolve the tenant workspace');
    }
    const persisted = await InboundPersistenceService.persist({
      connectionId: msg.connectionId,
      provider: msg.channel,
      providerUserId: msg.channelUserIdentifier,
      content: msg.content,
      messageType: msg.messageType,
      fullName: msg.senderName || 'Customer',
      username: msg.username,
      detectedLanguage: classification.language,
      detectedIntent: classification.intent,
      sentiment: classification.sentiment,
      providerEventId: msg.providerEventId,
    });

    if (persisted.isDuplicateEvent) {
      // Already fully processed this exact provider event; nothing further to do.
      return;
    }

    // 2b. Issue #33: if classification extracted lead info (name/phone/
    // product/budget), idempotently upsert a leads row for this customer.
    // Best-effort — extraction failures must never block message handling.
    if (classification.extractedLeadInfo) {
      const { product, budget } = classification.extractedLeadInfo;
      if (product || budget) {
        try {
          await LeadExtractorService.extractAndSaveLead({
            connectionId: msg.connectionId,
            customerId: persisted.customerId,
            conversationId: persisted.conversationId,
            requestedProductOrService: product,
            budget,
          });
        } catch (err) {
          console.error('Lead extraction failed (non-fatal):', err);
        }
      }
    }

    const conversation = {
      id: persisted.conversationId,
      mode: persisted.conversationMode,
      status: persisted.conversationStatus,
    };

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
      //
      // Issue #74: this insert must also be idempotent per provider event —
      // a worker retry after a post-commit-but-pre-`processed` crash must
      // not create a second draft/suggestion for the same original customer
      // message. `existing` is evaluated once, from the same statement
      // snapshot as `superseded`/`ins`, so a genuine retry (same
      // providerEventId, already has a row in `messages` via the unique
      // index on source_provider_event_id) skips both the supersede and the
      // insert. Two concurrent attempts for the SAME provider event both
      // see `existing` empty and both attempt the insert; the partial
      // unique index plus ON CONFLICT DO NOTHING lets only one succeed —
      // the loser's harmless no-op supersede is idempotent, and the final
      // state has exactly one live draft either way.
      const draftStatus = currentMode === 'approval' ? 'pending_approval' : 'suggested';
      const inserted = await query(
        `WITH existing AS (
           SELECT id FROM messages
           WHERE source_provider_event_id = $5::uuid
         ),
         superseded AS (
           UPDATE messages SET delivery_status = 'stale'
           WHERE conversation_id = $1 AND delivery_status IN ('pending_approval', 'suggested')
             AND $5::uuid IS NOT NULL AND NOT EXISTS (SELECT 1 FROM existing)
         )
         INSERT INTO messages (conversation_id, sender, content, message_type, delivery_status, ai_confidence, source_provider_event_id)
         SELECT $1, 'ai', $2, 'text', $3, $4, $5::uuid
         WHERE $5::uuid IS NULL OR NOT EXISTS (SELECT 1 FROM existing)
         ON CONFLICT (source_provider_event_id) WHERE source_provider_event_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [conversation.id, aiReplyText, draftStatus, classification.confidenceScore, msg.providerEventId ?? null]
      );

      const insertedId = inserted.rows[0]?.id;
      if (!insertedId) {
        // Either a genuine duplicate retry for this provider event (already
        // generated) or lost the race to a concurrent attempt — either way
        // there is nothing further to do here.
        return;
      }

      await AuditLogService.logEvent({
        workspaceId: msg.workspaceId,
        actorType: 'ai_agent',
        action: currentMode === 'approval' ? 'message.draft_created' : 'message.suggestion_created',
        entityType: 'message',
        entityId: insertedId,
        newValue: { conversationId: conversation.id, deliveryStatus: draftStatus },
      });
      return;
    }

    // 'auto': insert as 'pending', create an outbound_jobs row, and enqueue
    // it for the outbound worker (#46) — the provider call itself no longer
    // happens synchronously here. The worker owns marking the job
    // sent/failed/ambiguous and, alongside that, updating this message's
    // delivery_status, so the two stay consistent (see
    // outbound.ts:updateMessageDeliveryStatus). Deriving workspace_id,
    // connection_id, and channel fresh from `conversations` (not from
    // msg.workspaceId/msg.connectionId, which are not trusted for writes —
    // see the comment at the top of this function) keeps job creation
    // tenant-safe the same way persist_inbound_message is.
    const convRow = await query(
      `SELECT c.workspace_id, c.connection_id, c.channel,
              COALESCE(cust.telegram_id, cust.instagram_id) AS recipient_id
       FROM conversations c
       JOIN customers cust ON cust.id = c.customer_id
       WHERE c.id = $1`,
      [conversation.id]
    );
    const convInfo = convRow.rows[0];
    if (!convInfo?.connection_id || !convInfo?.recipient_id) {
      // No usable connection/recipient to dispatch to — record as failed
      // rather than silently dropping the AI reply. Idempotent per
      // provider event for the same reason as the approval/suggestion
      // insert above (issue #74): ON CONFLICT DO NOTHING on
      // source_provider_event_id means a retry of the same event doesn't
      // record a second failed message.
      const aiInsert = await query(
        `INSERT INTO messages (conversation_id, sender, content, message_type, delivery_status, ai_confidence, source_provider_event_id)
         VALUES ($1, 'ai', $2, 'text', 'failed', $3, $4::uuid)
         ON CONFLICT (source_provider_event_id) WHERE source_provider_event_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [conversation.id, aiReplyText, classification.confidenceScore, msg.providerEventId ?? null]
      );
      const failedId = aiInsert.rows[0]?.id;
      if (!failedId) return;
      console.error(`No dispatchable connection/recipient for conversation ${conversation.id}; message ${failedId} marked failed`);
      return;
    }

    // Message insert + job creation + enqueue are one atomic transaction —
    // a crash between message-persist and job-creation used to leave a
    // 'pending' message with no outbound_job and nothing to ever notice
    // (a stranded, silently-undelivered reply). Postgres makes a row
    // inserted earlier in a transaction visible to later statements in
    // that same transaction even before COMMIT, so the job insert's FK to
    // `messages` is satisfiable without needing the message committed
    // first — the two writes never need to be split.
    //
    // Issue #74: the message insert is also idempotent per provider event
    // (ON CONFLICT DO NOTHING on source_provider_event_id, additive within
    // this same transaction — not a separate step, so it can't reopen the
    // #46 atomicity gap). A worker retry after this transaction committed
    // but before provider_events was marked 'processed' re-enters here with
    // the same providerEventId: the insert conflicts, no id comes back, and
    // this whole function returns without creating a second message/job/
    // enqueue. Two workers racing the same provider event both attempt the
    // insert; the unique index lets only one win, so only one job/enqueue
    // is ever created.
    const client = await pool.connect();
    let messageId: string | undefined;
    try {
      await client.query('BEGIN');
      const aiInsert = await client.query(
        `INSERT INTO messages (conversation_id, sender, content, message_type, delivery_status, ai_confidence, source_provider_event_id)
         VALUES ($1, 'ai', $2, 'text', 'pending', $3, $4::uuid)
         ON CONFLICT (source_provider_event_id) WHERE source_provider_event_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [conversation.id, aiReplyText, classification.confidenceScore, msg.providerEventId ?? null]
      );
      messageId = aiInsert.rows[0]?.id;
      if (!messageId) {
        // Already generated a response for this provider event (retry) or
        // lost a concurrent race — commit the empty transaction and stop;
        // nothing further to do.
        await client.query('COMMIT');
        return;
      }
      const job = await createJob(
        {
          workspaceId: convInfo.workspace_id,
          connectionId: convInfo.connection_id,
          channel: convInfo.channel,
          messageId,
          recipientId: String(convInfo.recipient_id),
          content: aiReplyText,
        },
        client
      );
      await enqueueOutboundJob(client, job.id);
      await client.query('COMMIT');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      // DuplicateActiveJobError can't actually occur here (messageId is
      // freshly generated inside this same transaction, so no prior job
      // could exist for it) — any error here means the whole transaction
      // (including the message insert) rolled back, so there is nothing
      // stranded to mark 'failed'. Rethrow so the caller (the inbound
      // worker) sees this as a retryable failure of the whole inbound
      // event, same as any other error at this point in the pipeline.
      throw error;
    } finally {
      client.release();
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
