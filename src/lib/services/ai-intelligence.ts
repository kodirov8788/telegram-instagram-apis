import { UnifiedMessageDTO } from './message-queue';
import { AIClassifierService } from './ai-classifier';
import { KnowledgeBaseService } from './knowledge-base';
import { TelegramService } from './telegram';
import { InstagramService } from './instagram';
import pool, { query } from '../db';

export class AIIntelligenceService {
  static async processIncomingMessage(msg: UnifiedMessageDTO) {
    console.log(`Processing incoming message from ${msg.channel}: "${msg.content}"`);

    // 1. Classify language, intent, sentiment, and extract lead info
    const classification = await AIClassifierService.classifyMessage(msg.content);

    // 2. Check or upsert Customer & Conversation record
    const customerRes = await query(
      `INSERT INTO customers (workspace_id, full_name, ${msg.channel}_username, ${msg.channel}_id, preferred_language, last_contact_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT DO UPDATE SET last_contact_at = NOW()
       RETURNING id`,
      [msg.workspaceId, msg.senderName || 'Customer', msg.username, msg.channelUserIdentifier, classification.language]
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
        `INSERT INTO conversations (workspace_id, customer_id, channel, status, mode, detected_language, detected_intent, sentiment)
         VALUES ($1, $2, $3, 'new', 'auto', $4, $5, $6)
         RETURNING *`,
        [msg.workspaceId, customerId, msg.channel, classification.language, classification.intent, classification.sentiment]
      );
      conversation = newConv.rows[0];
    }

    // Save inbound message
    await query(
      `INSERT INTO messages (conversation_id, sender, content, message_type, delivery_status)
       VALUES ($1, 'customer', $2, $3, 'delivered')`,
      [conversation.id, msg.content, msg.messageType]
    );

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

    // Save AI message to database
    await query(
      `INSERT INTO messages (conversation_id, sender, content, message_type, delivery_status, ai_confidence)
       VALUES ($1, 'ai', $2, 'text', 'sent', $3)`,
      [conversation.id, aiReplyText, classification.confidenceScore]
    );

    // 6. Send Response if Mode is 'auto'
    if (conversation.mode === 'auto') {
      await this.dispatchOutboundMessage(msg, aiReplyText);
    }
  }

  private static async dispatchOutboundMessage(msg: UnifiedMessageDTO, text: string) {
    if (msg.channel === 'telegram') {
      const token = process.env.TELEGRAM_BOT_TOKEN || '';
      if (token) {
        const tg = new TelegramService(token);
        await tg.sendMessage(msg.channelUserIdentifier, text);
      }
    } else if (msg.channel === 'instagram') {
      const token = process.env.INSTAGRAM_PAGE_ACCESS_TOKEN || '';
      if (token) {
        const ig = new InstagramService(token);
        await ig.sendDirectMessage(msg.channelUserIdentifier, text);
      }
    }
  }
}
