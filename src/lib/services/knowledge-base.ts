import OpenAI from 'openai';
import pool, { query } from '../db';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || 'dummy_key' });

export interface KnowledgeItem {
  id?: string;
  workspaceId: string;
  title: string;
  content: string;
  category?: 'faq' | 'catalog' | 'policy' | 'script';
  language?: 'uz' | 'ru' | 'en';
  isApproved?: boolean;
}

export class KnowledgeBaseService {
  static async addKnowledgeItem(item: KnowledgeItem) {
    let embeddingString: string | null = null;
    
    if (process.env.OPENAI_API_KEY) {
      try {
        const response = await openai.embeddings.create({
          model: 'text-embedding-3-small',
          input: `${item.title}: ${item.content}`,
        });
        embeddingString = `[${response.data[0].embedding.join(',')}]`;
      } catch (err) {
        console.warn('Embedding generation skipped (no key or error):', err);
      }
    }

    const res = await query(
      `INSERT INTO knowledge_items (workspace_id, title, content, category, language, embedding, is_approved)
       VALUES ($1, $2, $3, $4, $5, $6::vector, $7)
       RETURNING id, title, category, language, is_approved`,
      [
        item.workspaceId,
        item.title,
        item.content,
        item.category || 'faq',
        item.language || 'uz',
        embeddingString,
        item.isApproved !== undefined ? item.isApproved : true
      ]
    );

    return res.rows[0];
  }

  static async searchRelevantKnowledge(workspaceId: string, queryText: string, language: string = 'uz', limit: number = 3) {
    if (!process.env.OPENAI_API_KEY) {
      // Fallback keyword search if no OpenAI API Key configured
      const res = await query(
        `SELECT id, title, content, category 
         FROM knowledge_items 
         WHERE workspace_id = $1 AND is_approved = true
         ORDER BY created_at DESC LIMIT $2`,
        [workspaceId, limit]
      );
      return res.rows;
    }

    try {
      const response = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: queryText,
      });
      const queryEmbedding = `[${response.data[0].embedding.join(',')}]`;

      const res = await query(
        `SELECT id, title, content, category, (embedding <=> $1::vector) as distance
         FROM knowledge_items
         WHERE workspace_id = $2 AND is_approved = true
         ORDER BY distance ASC
         LIMIT $3`,
        [queryEmbedding, workspaceId, limit]
      );
      return res.rows;
    } catch (err) {
      console.error('Vector search error, falling back to basic query:', err);
      const res = await query(
        `SELECT id, title, content FROM knowledge_items WHERE workspace_id = $1 LIMIT $2`,
        [workspaceId, limit]
      );
      return res.rows;
    }
  }
}
