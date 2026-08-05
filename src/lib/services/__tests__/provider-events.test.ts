import { beforeEach, describe, expect, it, vi } from 'vitest';
import { insertProviderEvent } from '../provider-events';
import { createHash } from 'node:crypto';

// Setup database query mock state to simulate UNIQUE constraints in unit tests
const dbStore = new Set<string>();

const mocks = vi.hoisted(() => ({
  dbQuery: vi.fn(),
  runtimeRoleTransaction: vi.fn(),
  clientQueries: [] as Array<{ text: string; params: unknown[] }>,
}));

vi.mock('@/lib/db', () => ({
  query: mocks.dbQuery,
  runtimeRoleTransaction: mocks.runtimeRoleTransaction,
  default: { connect: vi.fn() },
}));

describe('ProviderEvents Service (Unit Tests)', () => {
  beforeEach(() => {
    dbStore.clear();
    mocks.clientQueries.length = 0;
    vi.clearAllMocks();

    // Mock runtimeRoleTransaction to execute the callback immediately with a mocked db client
    mocks.runtimeRoleTransaction.mockImplementation(async (callback) => {
      const mockClient = {
        query: vi.fn().mockImplementation(async (text, params) => {
          mocks.clientQueries.push({ text, params });
          if (text.includes('INSERT INTO public.provider_events')) {
            const [workspaceId, connectionId, provider, providerEventId, payload, payloadHash] = params;
            const key = `${connectionId}:${providerEventId}`;
            if (dbStore.has(key)) {
              return { rows: [], rowCount: 0 };
            }
            dbStore.add(key);
            return {
              rows: [{ id: 'mocked-event-uuid', status: 'received' }],
              rowCount: 1,
            };
          }
          return { rows: [], rowCount: 0 };
        }),
      };
      return callback(mockClient);
    });
  });

  describe('insertProviderEvent', () => {
    const workspaceId = 'workspace-123';
    const connectionId = 'connection-abc';
    const webhookIdentifier = 'webhook-uuid-789';

    it('inserts a provider event successfully on first attempt', async () => {
      const result = await insertProviderEvent({
        workspaceId,
        connectionId,
        provider: 'telegram',
        providerEventId: 'up-100',
        payload: { text: 'hello' },
        webhookIdentifier,
      });

      expect(result).toEqual({
        id: 'mocked-event-uuid',
        status: 'received',
        isDuplicate: false,
      });
      const expectedKey = `${connectionId}:up-100`;
      expect(dbStore.has(expectedKey)).toBe(true);
      expect(mocks.clientQueries).toContainEqual({
        text: "SELECT set_config('app.webhook_provider', $1, true)",
        params: ['telegram'],
      });
    });

    it('deduplicates a duplicate provider event for the same connection', async () => {
      // First insert
      const firstResult = await insertProviderEvent({
        workspaceId,
        connectionId,
        provider: 'telegram',
        providerEventId: 'up-100',
        payload: { text: 'hello' },
        webhookIdentifier,
      });
      expect(firstResult.isDuplicate).toBe(false);

      // Second insert (duplicate)
      const secondResult = await insertProviderEvent({
        workspaceId,
        connectionId,
        provider: 'telegram',
        providerEventId: 'up-100',
        payload: { text: 'hello' },
        webhookIdentifier,
      });

      expect(secondResult).toEqual({
        id: null,
        status: null,
        isDuplicate: true,
      });
    });

    it('allows the same event ID across different connections', async () => {
      const connection2 = 'connection-xyz';

      const res1 = await insertProviderEvent({
        workspaceId,
        connectionId,
        provider: 'telegram',
        providerEventId: 'up-100',
        payload: { text: 'hello' },
        webhookIdentifier,
      });
      expect(res1.isDuplicate).toBe(false);

      const res2 = await insertProviderEvent({
        workspaceId,
        connectionId: connection2,
        provider: 'telegram',
        providerEventId: 'up-100',
        payload: { text: 'hello' },
        webhookIdentifier,
      });

      expect(res2.isDuplicate).toBe(false);
      expect(res2.id).toBe('mocked-event-uuid');
    });

    it('handles 10 concurrent same-event attempts and inserts only one', async () => {
      const attempts = Array.from({ length: 10 }).map(() =>
        insertProviderEvent({
          workspaceId,
          connectionId,
          provider: 'telegram',
          providerEventId: 'concurrent-update-id',
          payload: { text: 'concurrent' },
          webhookIdentifier,
        })
      );

      const results = await Promise.all(attempts);
      const inserted = results.filter(r => !r.isDuplicate);
      const duplicates = results.filter(r => r.isDuplicate);

      expect(inserted.length).toBe(1);
      expect(duplicates.length).toBe(9);
    });
  });
});
