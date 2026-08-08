/**
 * Response guardrails for AI-generated replies (issue #31).
 *
 * MVP approach — deliberately NOT a prompt-management platform:
 *
 * 1. Restricted-topic check runs on the INBOUND message, before any reply is
 *    synthesized. If the customer is asking for medical, legal, or financial
 *    (investment) advice, we never attempt to answer it from the knowledge
 *    base — we return a fixed, language-matched deflection. Keyword-based on
 *    purpose: cheap, deterministic, easy to extend, good enough for the
 *    handful of topics this MVP needs to refuse.
 *
 * 2. Grounding check runs on the OUTBOUND reply text against the retrieved
 *    knowledge snippets. `ai-intelligence.ts` currently synthesizes replies
 *    by quoting the top retrieved knowledge item verbatim (or a fixed
 *    "I don't know" fallback when nothing was retrieved) — so replies are
 *    grounded by construction today. This check exists as defense in depth
 *    for that invariant and to catch regressions if reply synthesis is ever
 *    changed to a freer-form LLM call: it flags price-like numbers or
 *    availability claims in the reply that don't appear in any retrieved
 *    snippet. A lightweight pattern-match heuristic is intentional — a
 *    stricter citation-based approach is unnecessary while synthesis is
 *    template-based, and would be revisited if/when free-form LLM synthesis
 *    is introduced.
 */

export type SupportedLanguage = 'uz' | 'ru' | 'en';

export interface KnowledgeSnippet {
  title?: string;
  content: string;
}

export interface GroundingResult {
  grounded: boolean;
  reason?: string;
}

// --- Restricted topics -----------------------------------------------------

// Keyword lists per language. Intentionally simple substring/word matching —
// good enough to catch the common phrasing this MVP needs to refuse, not a
// full NLU classifier.
const RESTRICTED_TOPIC_KEYWORDS: Record<string, string[]> = {
  medical: [
    // en
    'diagnos', 'symptom', 'medicine', 'medication', 'dosage', 'dose', 'treatment', 'disease', 'prescri', 'cure for', 'is it safe to take',
    // ru
    'диагноз', 'симптом', 'лекарств', 'дозировк', 'лечени', 'болезн', 'рецепт',
    // uz
    'tashxis', 'alomat', "dori", 'davolash', 'kasallik', 'retsept',
  ],
  legal: [
    // en
    'sue', 'lawsuit', 'legal advice', 'is it legal', 'contract law', 'my rights', 'file a claim', 'court case',
    // ru
    'подать в суд', 'юридическ', 'мои права', 'иск',
    // uz
    "sudga berish", 'huquqiy maslahat', 'huquqim', "da'vo",
  ],
  financial: [
    // en
    'invest in', 'investment advice', 'which stock', 'should i buy stock', 'crypto investment', 'financial advice', 'tax advice', 'loan advice',
    // ru
    'куда инвестировать', 'финансовый совет', 'какие акции', 'налоговый совет',
    // uz
    "qayerga sarmoya", "moliyaviy maslahat", "qaysi aksiya", "soliq bo'yicha maslahat",
  ],
};

export function isRestrictedTopic(text: string): boolean {
  const lower = text.toLowerCase();
  return Object.values(RESTRICTED_TOPIC_KEYWORDS).some(keywords =>
    keywords.some(kw => lower.includes(kw.toLowerCase()))
  );
}

const RESTRICTED_TOPIC_REPLY: Record<SupportedLanguage, string> = {
  en: "I'm not able to provide medical, legal, or financial advice. Let me connect you with a person who can help.",
  ru: 'Я не могу давать медицинские, юридические или финансовые консультации. Я передам ваш запрос сотруднику.',
  uz: "Men tibbiy, huquqiy yoki moliyaviy maslahat bera olmayman. So'rovingizni xodimga yo'naltiraman.",
};

export function getRestrictedTopicReply(language: SupportedLanguage): string {
  return RESTRICTED_TOPIC_REPLY[language] ?? RESTRICTED_TOPIC_REPLY.en;
}

// --- Safe "no grounded answer" fallback ------------------------------------

const SAFE_FALLBACK_REPLY: Record<SupportedLanguage, string> = {
  ru: 'К сожалению, у меня нет точной информации по вашему вопросу. Я передам запрос менеджеру.',
  en: "I apologize, but I don't have exact information regarding your question. I will forward this to our manager.",
  uz: "Afsuski, bu savol bo'yicha aniq ma'lumotga ega emasman. So'rovingizni menejerga yo'naltiraman.",
};

export function getSafeFallbackReply(language: SupportedLanguage): string {
  return SAFE_FALLBACK_REPLY[language] ?? SAFE_FALLBACK_REPLY.uz;
}

// --- Grounding heuristic -----------------------------------------------------

// Matches price-like tokens: currency symbols/codes near a number, or a bare
// number followed by a known currency word (so'm, сум, dollar, rubl, etc.).
const PRICE_PATTERN =
  /(\$|USD|EUR|RUB|UZS|₽|so'?m|сум|dollar|доллар|рубл)\s?\d[\d,.]*|\d[\d,.]*\s?(\$|USD|EUR|RUB|UZS|₽|so'?m|сум|dollar|доллар|рубл)/i;

// Availability/stock claim phrases across the three languages.
const AVAILABILITY_PATTERN =
  /\b(in stock|out of stock|available now|currently unavailable|mavjud|omborda (bor|yo'q)|наличии|в наличии|нет в наличии)\b/i;

/**
 * Checks whether a candidate reply's price/availability claims are backed by
 * the retrieved knowledge snippets. Returns grounded:false when the reply
 * contains a price-like or availability-like claim that does not appear
 * (as a substring, case-insensitive) in any retrieved snippet.
 *
 * This intentionally does NOT try to verify every factual claim in the
 * reply — only the two categories the issue calls out as MVP-critical
 * (price, availability). General open-ended fact-checking is out of scope.
 */
export function checkGrounding(replyText: string, knowledgeDocs: KnowledgeSnippet[]): GroundingResult {
  const contextText = knowledgeDocs.map(d => d.content).join('\n').toLowerCase();
  const reply = replyText.toLowerCase();

  const priceMatch = reply.match(PRICE_PATTERN);
  if (priceMatch && !contextText.includes(priceMatch[0].toLowerCase())) {
    return { grounded: false, reason: 'reply states a price not present in retrieved knowledge' };
  }

  const availabilityMatch = reply.match(AVAILABILITY_PATTERN);
  if (availabilityMatch && !contextText.includes(availabilityMatch[0].toLowerCase())) {
    return { grounded: false, reason: 'reply makes an availability claim not present in retrieved knowledge' };
  }

  return { grounded: true };
}

/**
 * Full guardrail pipeline used by ai-intelligence.ts to decide what to
 * actually send/draft, given the inbound message and retrieved knowledge.
 * Pure and synchronous (aside from taking already-fetched knowledgeDocs) —
 * callers keep full control over any DB/queueing side effects.
 */
export function buildGuardedReply(
  inboundText: string,
  language: SupportedLanguage,
  knowledgeDocs: KnowledgeSnippet[]
): { text: string; grounded: boolean; usedFallback: boolean } {
  if (isRestrictedTopic(inboundText)) {
    return { text: getRestrictedTopicReply(language), grounded: true, usedFallback: false };
  }

  if (knowledgeDocs.length === 0) {
    return { text: getSafeFallbackReply(language), grounded: true, usedFallback: true };
  }

  const draft = `[Knowledge Base Answer]\n${knowledgeDocs[0].content}`;
  const grounding = checkGrounding(draft, knowledgeDocs);
  if (!grounding.grounded) {
    // Defense in depth: should not happen while synthesis just quotes the
    // retrieved snippet verbatim, but if it ever does, never send/draft the
    // ungrounded text — fall back to the safe reply instead.
    console.warn('Guardrail rejected ungrounded reply:', grounding.reason);
    return { text: getSafeFallbackReply(language), grounded: false, usedFallback: true };
  }

  return { text: draft, grounded: true, usedFallback: false };
}
