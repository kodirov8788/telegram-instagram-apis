import OpenAI from 'openai';
import { query, type DbClient } from '../db';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || 'dummy_key' });

export interface KnowledgeItem {
  id?: string;
  workspaceId: string;
  title: string;
  content: string;
  category?: 'faq' | 'catalog' | 'policy' | 'script';
  language?: 'uz' | 'ru' | 'en';
  isApproved?: boolean;
  validFrom?: string | null;
  validUntil?: string | null;
}

export interface KnowledgeItemUpdate {
  title?: string;
  content?: string;
  category?: 'faq' | 'catalog' | 'policy' | 'script';
  language?: 'uz' | 'ru' | 'en';
  isApproved?: boolean;
  validFrom?: string | null;
  validUntil?: string | null;
}

async function embed(text: string): Promise<string | null> {
  if (!process.env.OPENAI_API_KEY) return null;
  try {
    const response = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: text,
    });
    return `[${response.data[0].embedding.join(',')}]`;
  } catch (err) {
    console.warn('Embedding generation skipped (no key or error):', err);
    return null;
  }
}

// Validity-window predicate shared by both retrieval paths below — an item
// is servable only when today falls within [valid_from, valid_until]
// (either bound may be NULL, meaning unbounded on that side).
const VALIDITY_CLAUSE = '(valid_from IS NULL OR valid_from <= CURRENT_DATE) AND (valid_until IS NULL OR valid_until >= CURRENT_DATE)';

export class KnowledgeBaseService {
  static async addKnowledgeItem(item: KnowledgeItem, client: DbClient = { query }) {
    const embeddingString = await embed(`${item.title}: ${item.content}`);

    const res = await client.query(
      `INSERT INTO knowledge_items (workspace_id, title, content, category, language, embedding, is_approved, valid_from, valid_until)
       VALUES ($1, $2, $3, $4, $5, $6::vector, $7, $8, $9)
       RETURNING id, workspace_id, title, content, category, language, is_approved, valid_from, valid_until, created_at, updated_at`,
      [
        item.workspaceId,
        item.title,
        item.content,
        item.category || 'faq',
        item.language || 'uz',
        embeddingString,
        item.isApproved !== undefined ? item.isApproved : true,
        item.validFrom ?? null,
        item.validUntil ?? null,
      ]
    );

    return res.rows[0];
  }

  static async listKnowledgeItems(
    workspaceId: string,
    filters: { category?: string; language?: string; isApproved?: boolean } = {},
    client: DbClient = { query }
  ) {
    const params: unknown[] = [workspaceId];
    let sql = `SELECT id, workspace_id, title, content, category, language, is_approved, valid_from, valid_until, created_at, updated_at
               FROM knowledge_items WHERE workspace_id = $1`;
    if (filters.category) { params.push(filters.category); sql += ` AND category = $${params.length}`; }
    if (filters.language) { params.push(filters.language); sql += ` AND language = $${params.length}`; }
    if (filters.isApproved !== undefined) { params.push(filters.isApproved); sql += ` AND is_approved = $${params.length}`; }
    sql += ' ORDER BY created_at DESC';
    const res = await client.query(sql, params);
    return res.rows;
  }

  static async getKnowledgeItem(workspaceId: string, id: string, client: DbClient = { query }) {
    const res = await client.query(
      `SELECT id, workspace_id, title, content, category, language, is_approved, valid_from, valid_until, created_at, updated_at
       FROM knowledge_items WHERE id = $1 AND workspace_id = $2`,
      [id, workspaceId]
    );
    return res.rows[0] ?? null;
  }

  /**
   * Updates a knowledge item. Regenerates the embedding whenever `content`
   * (or `title`, since the embedding input is `title: content`) changes —
   * an update that changes content but leaves the old embedding in place
   * would silently keep serving stale results for new-content searches.
   */
  static async updateKnowledgeItem(workspaceId: string, id: string, updates: KnowledgeItemUpdate, client: DbClient = { query }) {
    const existing = await KnowledgeBaseService.getKnowledgeItem(workspaceId, id, client);
    if (!existing) return null;

    const nextTitle = updates.title ?? existing.title;
    const nextContent = updates.content ?? existing.content;
    const contentChanged = updates.title !== undefined || updates.content !== undefined;

    const embeddingString = contentChanged ? await embed(`${nextTitle}: ${nextContent}`) : undefined;

    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (col: string, value: unknown) => { params.push(value); sets.push(`${col} = $${params.length}`); };

    push('title', nextTitle);
    push('content', nextContent);
    if (updates.category !== undefined) push('category', updates.category);
    if (updates.language !== undefined) push('language', updates.language);
    if (updates.isApproved !== undefined) push('is_approved', updates.isApproved);
    if (updates.validFrom !== undefined) push('valid_from', updates.validFrom);
    if (updates.validUntil !== undefined) push('valid_until', updates.validUntil);
    if (embeddingString !== undefined) { params.push(embeddingString); sets.push(`embedding = $${params.length}::vector`); }
    sets.push('updated_at = NOW()');

    params.push(id, workspaceId);
    const res = await client.query(
      `UPDATE knowledge_items SET ${sets.join(', ')}
       WHERE id = $${params.length - 1} AND workspace_id = $${params.length}
       RETURNING id, workspace_id, title, content, category, language, is_approved, valid_from, valid_until, created_at, updated_at`,
      params
    );
    return res.rows[0] ?? null;
  }

  static async setApproval(workspaceId: string, id: string, isApproved: boolean, client: DbClient = { query }) {
    const res = await client.query(
      `UPDATE knowledge_items SET is_approved = $1, updated_at = NOW()
       WHERE id = $2 AND workspace_id = $3
       RETURNING id, workspace_id, title, content, category, language, is_approved, valid_from, valid_until, created_at, updated_at`,
      [isApproved, id, workspaceId]
    );
    return res.rows[0] ?? null;
  }

  // Hard delete: knowledge_items has no incoming FK references (verified
  // against schema.sql) and the embedding column carries no external
  // state, so there is nothing else to reconcile. Unlike messages/leads,
  // there's no "unapprove" ambiguity to preserve — is_approved already
  // covers the "stop serving this" case; DELETE is for actually removing it.
  static async deleteKnowledgeItem(workspaceId: string, id: string, client: DbClient = { query }) {
    const res = await client.query(
      `DELETE FROM knowledge_items WHERE id = $1 AND workspace_id = $2 RETURNING id`,
      [id, workspaceId]
    );
    return res.rows[0] ?? null;
  }

  static async searchRelevantKnowledge(workspaceId: string, queryText: string, language: string = 'uz', limit: number = 3) {
    const embeddingString = await embed(queryText);

    if (embeddingString) {
      try {
        const res = await query(
          `SELECT id, title, content, category, (embedding <=> $1::vector) as distance
           FROM knowledge_items
           WHERE workspace_id = $2 AND is_approved = true AND language = $3 AND ${VALIDITY_CLAUSE}
           ORDER BY distance ASC
           LIMIT $4`,
          [embeddingString, workspaceId, language, limit]
        );
        return res.rows;
      } catch (err) {
        console.error('Vector search error, falling back to keyword query:', err);
      }
    }

    // Fallback: no OpenAI key, embedding generation failed, or the vector
    // query itself errored. Must apply the exact same approval/language/
    // validity filtering as the embedding path above — this is the bug
    // fixed here (previously this branch ignored all three).
    const res = await query(
      `SELECT id, title, content, category
       FROM knowledge_items
       WHERE workspace_id = $1 AND is_approved = true AND language = $2 AND ${VALIDITY_CLAUSE}
       ORDER BY created_at DESC LIMIT $3`,
      [workspaceId, language, limit]
    );
    return res.rows;
  }
}
