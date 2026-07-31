import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || 'dummy_key' });

export interface ClassificationResult {
  language: 'uz' | 'ru' | 'en';
  intent: string;
  sentiment: 'positive' | 'neutral' | 'negative' | 'angry';
  confidenceScore: number;
  extractedLeadInfo?: {
    name?: string;
    phone?: string;
    product?: string;
    budget?: string;
  };
}

export class AIClassifierService {
  static async classifyMessage(messageText: string): Promise<ClassificationResult> {
    if (!process.env.OPENAI_API_KEY) {
      // Basic rule-based fallback if API key is not present
      const lower = messageText.toLowerCase();
      let language: ClassificationResult['language'] = 'uz';
      if (/[а-яА-Я]/.test(messageText)) language = 'ru';
      else if (/\b(hello|hi|price|how much|cost|order|buy)\b/.test(lower)) language = 'en';

      let intent = 'general_inquiry';
      if (lower.includes('narx') || lower.includes('цена') || lower.includes('price')) intent = 'price_inquiry';
      else if (lower.includes('bormi') || lower.includes('есть') || lower.includes('available')) intent = 'availability_inquiry';
      else if (lower.includes('human') || lower.includes('operator') || lower.includes('odam')) intent = 'human_agent_request';
      else if (lower.includes('refund') || lower.includes('vozvrat') || lower.includes('norozi')) intent = 'complaint';

      return {
        language,
        intent,
        sentiment: lower.includes('norozi') || lower.includes('bad') ? 'angry' : 'neutral',
        confidenceScore: 0.85,
      };
    }

    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `You are an AI Intent and Language Classifier for an e-commerce & customer service platform in Uzbekistan.
Analyze incoming messages and return a JSON object strictly matching this schema:
{
  "language": "uz" | "ru" | "en",
  "intent": "greeting" | "product_inquiry" | "price_inquiry" | "availability_inquiry" | "delivery_inquiry" | "complaint" | "refund_request" | "human_agent_request" | "general_inquiry",
  "sentiment": "positive" | "neutral" | "negative" | "angry",
  "confidenceScore": float between 0 and 1,
  "extractedLeadInfo": { "name": string, "phone": string, "product": string, "budget": string }
}`,
          },
          { role: 'user', content: messageText },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.1,
      });

      const parsed = JSON.parse(response.choices[0].message.content || '{}');
      return {
        language: parsed.language || 'uz',
        intent: parsed.intent || 'general_inquiry',
        sentiment: parsed.sentiment || 'neutral',
        confidenceScore: parsed.confidenceScore || 0.9,
        extractedLeadInfo: parsed.extractedLeadInfo,
      };
    } catch (err) {
      console.error('Classification LLM error:', err);
      return {
        language: 'uz',
        intent: 'general_inquiry',
        sentiment: 'neutral',
        confidenceScore: 0.5,
      };
    }
  }
}
