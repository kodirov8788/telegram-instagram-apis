import OpenAI from 'openai';
import { query } from '../db';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || 'dummy_key' });

export class ConversationSummarizerService {
  static async generateSummary(conversationId: string): Promise<string> {
    const res = await query(
      `SELECT sender, content, created_at FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
      [conversationId]
    );

    if (res.rows.length === 0) return 'No messages recorded.';

    const transcript = res.rows.map(r => `${r.sender.toUpperCase()}: ${r.content}`).join('\n');

    if (!process.env.OPENAI_API_KEY) {
      return `Summary: ${res.rows.length} messages exchanged. Last topic: ${res.rows[res.rows.length - 1].content}`;
    }

    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'Summarize the customer conversation concisely. List: 1. Customer request, 2. Products discussed, 3. Info collected, 4. Required next action.',
          },
          { role: 'user', content: transcript },
        ],
      });

      const summaryText = response.choices[0].message.content || 'Summary unavailable.';
      await query(`UPDATE conversations SET summary = $1 WHERE id = $2`, [summaryText, conversationId]);
      return summaryText;
    } catch (err) {
      console.error('Summarizer error:', err);
      return 'Summary generation error.';
    }
  }
}
