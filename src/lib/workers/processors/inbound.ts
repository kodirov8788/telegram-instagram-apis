import { AIClassifierService } from '../../services/ai-classifier';
import { KnowledgeBaseService } from '../../services/knowledge-base';
import { MessageNormalizerService, UnifiedMessageDTO } from '../../services/message-queue';
import { Provider } from '../../services/secret-provider';
import { TransactionRunner, workerRecordTransaction } from '../transaction';
import { RetryableWorkError } from '../errors';

interface ProviderEvent {
  id: string;
  workspace_id: string;
  connection_id: string;
  provider: Provider;
  payload: any;
  attempts: number;
}

interface Intelligence {
  language: string;
  intent: string;
  sentiment: string;
  confidenceScore: number;
  reply: string;
  handoff: boolean;
}

const MAX_INBOUND_ATTEMPTS = 8;

export interface InboundProcessorDependencies {
  transaction?: TransactionRunner;
  analyze?: (message: UnifiedMessageDTO) => Promise<Intelligence>;
}

async function defaultAnalyze(message: UnifiedMessageDTO): Promise<Intelligence> {
  const classification = await AIClassifierService.classifyMessage(message.content);
  const handoff = classification.intent === 'human_agent_request' || classification.intent === 'complaint' ||
    classification.intent === 'refund_request' || classification.sentiment === 'angry' || classification.confidenceScore < 0.6;
  if (handoff) {
    const reply = classification.language === 'ru'
      ? 'Ваш запрос передан оператору. Наш сотрудник ответит вам в ближайшее время.'
      : classification.language === 'en'
        ? 'Your request has been transferred to a human operator. We will respond shortly.'
        : "Sizning so'rovingiz operatorga uzatildi. Xodimimiz tez orada javob beradi.";
    return { ...classification, reply, handoff };
  }

  const docs = await KnowledgeBaseService.searchRelevantKnowledge(message.workspaceId, message.content, classification.language);
  const reply = docs[0]?.content ?? (classification.language === 'ru'
    ? 'К сожалению, у меня нет точной информации по вашему вопросу. Я передам запрос менеджеру.'
    : classification.language === 'en'
      ? "I apologize, but I don't have exact information regarding your question. I will forward this to our manager."
      : "Afsuski, bu savol bo'yicha aniq ma'lumotga ega emasman. So'rovingizni menejerga yo'naltiraman.");
  return { ...classification, reply, handoff: false };
}

function normalize(event: ProviderEvent): UnifiedMessageDTO | null {
  if (event.provider === 'telegram') return MessageNormalizerService.normalizeTelegramMessage(event.workspace_id, event.payload);
  const entry = event.payload?.entry?.[0]?.messaging?.[0] ?? event.payload;
  return MessageNormalizerService.normalizeInstagramMessage(event.workspace_id, entry);
}

/** Claims quickly, performs AI with no transaction held, then atomically persists the result. */
export async function processInboundEvent(providerEventId: string, dependencies: InboundProcessorDependencies = {}) {
  const transaction = dependencies.transaction ?? workerRecordTransaction('provider_events', providerEventId);
  const event = await transaction(async db => {
    const result = await db.query(
      `UPDATE provider_events SET status = 'processing', attempts = attempts + 1, updated_at = NOW()
       WHERE id = $1 AND (status IN ('received', 'queued', 'retryable_failed')
         OR (status = 'processing' AND updated_at < NOW() - INTERVAL '2 minutes')) RETURNING *`,
      [providerEventId]
    );
    return result.rows[0] as ProviderEvent | undefined;
  });
  if (!event) return { outcome: 'ignored' as const };

  const message = normalize(event);
  if (!message) {
    await finalizeEvent(transaction, event.id, 'permanent_failed', 'Unsupported provider event');
    return { outcome: 'permanent_failed' as const };
  }

  let intelligence: Intelligence;
  try {
    intelligence = await (dependencies.analyze ?? defaultAnalyze)(message);
  } catch {
    if (event.attempts >= MAX_INBOUND_ATTEMPTS) {
      await finalizeEvent(transaction, event.id, 'permanent_failed', 'Intelligence processing failed after maximum attempts');
      return { outcome: 'permanent_failed' as const };
    }
    await finalizeEvent(transaction, event.id, 'retryable_failed', 'Intelligence processing failed');
    throw new RetryableWorkError(5_000, 'Inbound intelligence processing is retryable');
  }

  return transaction(async db => {
    const usernameColumn = event.provider === 'telegram' ? 'telegram_username' : 'instagram_username';
    const idColumn = event.provider === 'telegram' ? 'telegram_id' : 'instagram_id';
    const customer = await db.query(
      `INSERT INTO customers (workspace_id, connection_id, provider_user_id, full_name, ${usernameColumn}, ${idColumn}, preferred_language, last_contact_at)
       VALUES ($1, $2, $3, $4, $5, $3, $6, NOW())
       ON CONFLICT (connection_id, provider_user_id) WHERE connection_id IS NOT NULL AND provider_user_id IS NOT NULL
       DO UPDATE SET full_name = COALESCE(EXCLUDED.full_name, customers.full_name),
         ${usernameColumn} = COALESCE(EXCLUDED.${usernameColumn}, customers.${usernameColumn}), last_contact_at = NOW()
       RETURNING id`,
      [event.workspace_id, event.connection_id, message.channelUserIdentifier, message.senderName || 'Customer', message.username ?? null, intelligence.language]
    );
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${event.connection_id}:${customer.rows[0].id}`]);
    let conversation = await db.query(
      `SELECT id, mode FROM conversations WHERE connection_id = $1 AND customer_id = $2
       AND status NOT IN ('resolved','closed','spam') ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [event.connection_id, customer.rows[0].id]
    );
    if (!conversation.rows[0]) {
      conversation = await db.query(
        `INSERT INTO conversations (workspace_id, connection_id, customer_id, channel, status, mode, detected_language, detected_intent, sentiment)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, mode`,
        [event.workspace_id, event.connection_id, customer.rows[0].id, event.provider,
          intelligence.handoff ? 'human_attention_required' : 'ai_handling', intelligence.handoff ? 'human' : 'auto',
          intelligence.language, intelligence.intent, intelligence.sentiment]
      );
    } else {
      await db.query(
        `UPDATE conversations SET detected_language=$2, detected_intent=$3, sentiment=$4, last_message_at=NOW(),
         status=CASE WHEN $5 THEN 'human_attention_required'::conversation_status ELSE status END,
         mode=CASE WHEN $5 THEN 'human'::control_mode ELSE mode END WHERE id=$1`,
        [conversation.rows[0].id, intelligence.language, intelligence.intent, intelligence.sentiment, intelligence.handoff]
      );
    }
    const inbound = await db.query(
      `INSERT INTO messages (conversation_id, workspace_id, sender, content, message_type, delivery_status, provider_event_id)
       VALUES ($1, $2, 'customer', $3, $4, 'delivered', $5)
       ON CONFLICT (provider_event_id) WHERE provider_event_id IS NOT NULL DO NOTHING RETURNING id`,
      [conversation.rows[0].id, event.workspace_id, message.content, message.messageType, event.id]
    );
    if (!inbound.rows[0]) {
      await db.query("UPDATE provider_events SET status = 'processed', processed_at = NOW(), completed_at = NOW(), last_error = NULL WHERE id = $1", [event.id]);
      return { outcome: 'duplicate' as const };
    }

    if (conversation.rows[0].mode === 'auto' || intelligence.handoff) {
      const outbound = await db.query(
        `INSERT INTO messages (conversation_id, workspace_id, parent_message_id, sender, content, message_type, delivery_status, ai_confidence)
         VALUES ($1, $2, $3, 'ai', $4, 'text', 'pending', $5) RETURNING id`,
        [conversation.rows[0].id, event.workspace_id, inbound.rows[0].id, intelligence.reply, intelligence.confidenceScore]
      );
      const job = await db.query(
        `INSERT INTO outbound_jobs (workspace_id, connection_id, conversation_id, message_id, idempotency_key, provider, recipient_id, status, attempts, next_attempt_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued', 0, NOW()) RETURNING id`,
        [event.workspace_id, event.connection_id, conversation.rows[0].id, outbound.rows[0].id,
          `provider-event:${event.id}`, event.provider, message.channelUserIdentifier]
      );
      await db.query("SELECT ydeck_queue.send('outbound_messages', jsonb_build_object('v',1,'outboundJobId',$1::text), 0)", [job.rows[0].id]);
    }
    await db.query("UPDATE provider_events SET status = 'processed', processed_at = NOW(), completed_at = NOW(), result_message_id = $2, result_conversation_id = $3, last_error = NULL WHERE id = $1", [event.id, inbound.rows[0].id, conversation.rows[0].id]);
    return { outcome: 'processed' as const };
  });
}

async function finalizeEvent(transaction: TransactionRunner, id: string, status: string, error: string) {
  await transaction(async db => {
    await db.query('UPDATE provider_events SET status = $2, last_error = $3, updated_at = NOW() WHERE id = $1', [id, status, error]);
  });
}
