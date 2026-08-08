import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db', () => ({ query: vi.fn(), default: { connect: vi.fn() } }));

import { query } from '../../db';
import { resolveChannelConnection } from '../webhook-connection-resolver';

const db = vi.mocked(query);

beforeEach(() => {
  db.mockReset();
});

describe('resolveChannelConnection', () => {
  it('resolves an active connection by channel + account identifier', async () => {
    db.mockResolvedValueOnce({
      rows: [{ id: 'conn-1', workspace_id: 'ws-1' }],
    } as never);

    const result = await resolveChannelConnection('instagram', 'ig-account-123');

    expect(result).toEqual({ connectionId: 'conn-1', workspaceId: 'ws-1' });
    expect(db).toHaveBeenCalledWith(expect.stringContaining('is_active = TRUE'), ['instagram', 'ig-account-123']);
  });

  it('returns null for an unknown account identifier instead of falling back to a default workspace', async () => {
    db.mockResolvedValueOnce({ rows: [] } as never);

    const result = await resolveChannelConnection('instagram', 'unregistered-account');

    expect(result).toBeNull();
  });

  it('returns null for an empty account identifier without querying the database', async () => {
    const result = await resolveChannelConnection('instagram', '');

    expect(result).toBeNull();
    expect(db).not.toHaveBeenCalled();
  });

  it('scopes the lookup to the requested channel, never returning a connection from another channel', async () => {
    // The query itself enforces `channel = $1`; this test asserts the
    // resolver passes the requested channel through unmodified rather than
    // e.g. searching across all channels for a matching account identifier.
    db.mockResolvedValueOnce({ rows: [] } as never);

    await resolveChannelConnection('telegram', 'shared-account-identifier');

    expect(db).toHaveBeenCalledWith(expect.any(String), ['telegram', 'shared-account-identifier']);
  });

  it('never returns a credentials field — callers must use the secret loader', async () => {
    db.mockResolvedValueOnce({
      rows: [{ id: 'conn-2', workspace_id: 'ws-2' }],
    } as never);

    const result = await resolveChannelConnection('instagram', 'ig-account-456');

    expect(result).not.toHaveProperty('credentials');
  });
});
