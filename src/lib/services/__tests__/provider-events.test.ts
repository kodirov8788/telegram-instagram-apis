import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock('../../db', () => ({ default: { connect: mocks.connect } }));

import { insertProviderEvent } from '../provider-events';

// Simulates the (connection_id, provider_event_id) UNIQUE index at the DB
// layer so these tests exercise real dedup semantics, not a stubbed answer.
function makeUuid(n: number) {
  const hex = n.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
}

function makeClient(dbStore: Set<string>) {
  let nextId = 1;
  const queries: Array<{ text: string; params?: unknown[] }> = [];
  const query = vi.fn(async (text: string, params: unknown[] = []) => {
    queries.push({ text, params });
    if (text.startsWith('INSERT INTO provider_events')) {
      const [, connectionId, , providerEventId] = params as string[];
      const key = `${connectionId}:${providerEventId}`;
      if (dbStore.has(key)) return { rows: [] }; // ON CONFLICT DO NOTHING
      dbStore.add(key);
      return { rows: [{ id: makeUuid(nextId++), status: 'received' }] };
    }
    if (text.includes('ydeck_queue.send')) {
      return { rows: [{ msg_id: '1' }] };
    }
    return { rows: [] };
  });
  return { query, release: vi.fn(), queries };
}

describe('insertProviderEvent', () => {
  let dbStore: Set<string>;

  beforeEach(() => {
    dbStore = new Set();
    mocks.connect.mockReset();
  });

  const input = (overrides: Partial<Parameters<typeof insertProviderEvent>[0]> = {}) => ({
    workspaceId: 'ws-1',
    connectionId: 'conn-1',
    provider: 'telegram' as const,
    providerEventId: 'update-100',
    payload: { text: 'hello' },
    ...overrides,
  });

  it('inserts a new provider event and enqueues it, in one commit', async () => {
    const client = makeClient(dbStore);
    mocks.connect.mockResolvedValue(client);

    const result = await insertProviderEvent(input());

    expect(result).toEqual({ id: makeUuid(1), status: 'queued', isDuplicate: false });
    expect(client.queries.map(q => q.text.split('\n')[0].trim())[0]).toBe('BEGIN');
    expect(client.queries.some(q => q.text.includes('ydeck_queue.send'))).toBe(true);
    expect(client.queries.at(-1)?.text).toBe('COMMIT');
  });

  it('deduplicates a redelivered event for the same connection and does not enqueue it again', async () => {
    mocks.connect.mockImplementation(async () => makeClient(dbStore));

    const first = await insertProviderEvent(input());
    const second = await insertProviderEvent(input());

    expect(first.isDuplicate).toBe(false);
    expect(second).toEqual({ id: null, status: null, isDuplicate: true });
  });

  it('allows the same provider event id across two different connections', async () => {
    mocks.connect.mockImplementation(async () => makeClient(dbStore));

    const first = await insertProviderEvent(input({ connectionId: 'conn-1' }));
    const second = await insertProviderEvent(input({ connectionId: 'conn-2' }));

    expect(first.isDuplicate).toBe(false);
    expect(second.isDuplicate).toBe(false);
  });

  it('handles 10 concurrent deliveries of the same event and inserts exactly once', async () => {
    mocks.connect.mockImplementation(async () => makeClient(dbStore));

    const results = await Promise.all(Array.from({ length: 10 }, () => insertProviderEvent(input({ providerEventId: 'concurrent-1' }))));

    expect(results.filter(r => !r.isDuplicate)).toHaveLength(1);
    expect(results.filter(r => r.isDuplicate)).toHaveLength(9);
  });

  it('rolls back without enqueueing when the row already existed', async () => {
    const client = makeClient(dbStore);
    mocks.connect.mockImplementation(async () => client);
    await insertProviderEvent(input());
    client.queries.length = 0;

    await insertProviderEvent(input());

    expect(client.queries.some(q => q.text.includes('ydeck_queue.send'))).toBe(false);
    expect(client.queries.at(-1)?.text).toBe('ROLLBACK');
  });
});
