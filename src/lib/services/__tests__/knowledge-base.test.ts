import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db', () => ({
  query: vi.fn(),
  default: { connect: vi.fn() },
}));

const createMock = vi.hoisted(() => vi.fn());
vi.mock('openai', () => ({
  default: class MockOpenAI {
    embeddings = { create: createMock };
  },
}));

import { query } from '../../db';
import { KnowledgeBaseService } from '../knowledge-base';

const db = vi.mocked(query);
const wid = '11111111-1111-4111-8111-111111111111';
const iid = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  db.mockReset();
  createMock.mockReset();
  delete process.env.OPENAI_API_KEY;
});

describe('searchRelevantKnowledge — fallback path (no OpenAI key)', () => {
  it('filters by workspace, approval, language, and validity window', async () => {
    db.mockResolvedValueOnce({ rows: [{ id: 'k1', title: 't', content: 'c', category: 'faq' }] } as never);

    const rows = await KnowledgeBaseService.searchRelevantKnowledge(wid, 'hours?', 'ru', 5);

    expect(rows).toHaveLength(1);
    const [sql, params] = db.mock.calls[0];
    expect(sql).toMatch(/is_approved = true/);
    expect(sql).toMatch(/language = \$2/);
    expect(sql).toMatch(/valid_from IS NULL OR valid_from <= CURRENT_DATE/);
    expect(sql).toMatch(/valid_until IS NULL OR valid_until >= CURRENT_DATE/);
    expect(params).toEqual([wid, 'ru', 5]);
  });
});

describe('searchRelevantKnowledge — embedding path', () => {
  it('applies identical approval/language/validity filtering as the fallback path', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    createMock.mockResolvedValueOnce({ data: [{ embedding: [0.1, 0.2] }] });
    db.mockResolvedValueOnce({ rows: [{ id: 'k1', title: 't', content: 'c', category: 'faq', distance: 0.01 }] } as never);

    const rows = await KnowledgeBaseService.searchRelevantKnowledge(wid, 'hours?', 'en', 3);

    expect(rows).toHaveLength(1);
    const [sql, params] = db.mock.calls[0];
    expect(sql).toMatch(/is_approved = true/);
    expect(sql).toMatch(/language = \$3/);
    expect(sql).toMatch(/valid_from IS NULL OR valid_from <= CURRENT_DATE/);
    expect(sql).toMatch(/valid_until IS NULL OR valid_until >= CURRENT_DATE/);
    expect(params?.[1]).toBe(wid);
    expect(params?.[2]).toBe('en');
    expect(params?.[3]).toBe(3);
  });

  it('falls back to the strict keyword query if the vector query errors', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    createMock.mockResolvedValueOnce({ data: [{ embedding: [0.1, 0.2] }] });
    db.mockRejectedValueOnce(new Error('vector op error'));
    db.mockResolvedValueOnce({ rows: [] } as never);

    const rows = await KnowledgeBaseService.searchRelevantKnowledge(wid, 'hours?', 'uz', 3);

    expect(rows).toEqual([]);
    expect(db).toHaveBeenCalledTimes(2);
    const [fallbackSql] = db.mock.calls[1];
    expect(fallbackSql).toMatch(/is_approved = true/);
    expect(fallbackSql).toMatch(/language = \$2/);
  });
});

describe('addKnowledgeItem', () => {
  it('generates an embedding when an API key is configured', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    createMock.mockResolvedValueOnce({ data: [{ embedding: [0.1, 0.2] }] });
    db.mockResolvedValueOnce({ rows: [{ id: iid, title: 'T', content: 'C' }] } as never);

    await KnowledgeBaseService.addKnowledgeItem({ workspaceId: wid, title: 'T', content: 'C' });

    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ input: 'T: C' }));
    const [, params] = db.mock.calls[0];
    expect(params?.[5]).toBe('[0.1,0.2]');
  });

  it('inserts with a null embedding when no API key is configured', async () => {
    db.mockResolvedValueOnce({ rows: [{ id: iid }] } as never);
    await KnowledgeBaseService.addKnowledgeItem({ workspaceId: wid, title: 'T', content: 'C' });
    expect(createMock).not.toHaveBeenCalled();
    const [, params] = db.mock.calls[0];
    expect(params?.[5]).toBeNull();
  });
});

describe('updateKnowledgeItem', () => {
  it('regenerates the embedding when content changes', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    db.mockResolvedValueOnce({ rows: [{ id: iid, workspace_id: wid, title: 'Old', content: 'Old content' }] } as never); // getKnowledgeItem
    createMock.mockResolvedValueOnce({ data: [{ embedding: [0.9] }] });
    db.mockResolvedValueOnce({ rows: [{ id: iid, title: 'Old', content: 'New content' }] } as never); // UPDATE

    await KnowledgeBaseService.updateKnowledgeItem(wid, iid, { content: 'New content' });

    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ input: 'Old: New content' }));
    const [updateSql, updateParams] = db.mock.calls[1];
    expect(updateSql).toMatch(/embedding = \$\d+::vector/);
    expect(updateParams).toContain('[0.9]');
  });

  it('does not touch the embedding when only non-content fields change', async () => {
    db.mockResolvedValueOnce({ rows: [{ id: iid, workspace_id: wid, title: 'Old', content: 'Old content' }] } as never); // getKnowledgeItem
    db.mockResolvedValueOnce({ rows: [{ id: iid, category: 'policy' }] } as never); // UPDATE

    await KnowledgeBaseService.updateKnowledgeItem(wid, iid, { category: 'policy' });

    expect(createMock).not.toHaveBeenCalled();
    const [updateSql] = db.mock.calls[1];
    expect(updateSql).not.toMatch(/embedding/);
  });

  it('returns null when the item does not exist in this tenant', async () => {
    db.mockResolvedValueOnce({ rows: [] } as never);
    const result = await KnowledgeBaseService.updateKnowledgeItem(wid, iid, { title: 'X' });
    expect(result).toBeNull();
  });
});

describe('listKnowledgeItems', () => {
  it('applies category/language/approval filters', async () => {
    db.mockResolvedValueOnce({ rows: [] } as never);
    await KnowledgeBaseService.listKnowledgeItems(wid, { category: 'faq', language: 'en', isApproved: false });
    const [sql, params] = db.mock.calls[0];
    expect(sql).toMatch(/category = \$2/);
    expect(sql).toMatch(/language = \$3/);
    expect(sql).toMatch(/is_approved = \$4/);
    expect(params).toEqual([wid, 'faq', 'en', false]);
  });
});

describe('deleteKnowledgeItem', () => {
  it('scopes deletion to the tenant', async () => {
    db.mockResolvedValueOnce({ rows: [{ id: iid }] } as never);
    const result = await KnowledgeBaseService.deleteKnowledgeItem(wid, iid);
    expect(result).toEqual({ id: iid });
    const [sql, params] = db.mock.calls[0];
    expect(sql).toMatch(/WHERE id = \$1 AND workspace_id = \$2/);
    expect(params).toEqual([iid, wid]);
  });
});
