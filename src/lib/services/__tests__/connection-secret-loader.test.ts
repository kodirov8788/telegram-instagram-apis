import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db', () => ({ query: vi.fn(), default: { connect: vi.fn() } }));

import { query } from '../../db';
import { getConnectionSecret, rotateConnectionSecret } from '../connection-secret-loader';

const db = vi.mocked(query);

beforeEach(() => {
  db.mockReset();
});

describe('getConnectionSecret', () => {
  it('resolves the decrypted secret for a matching (connection, workspace) pair', async () => {
    db.mockResolvedValueOnce({
      rows: [{ secret: JSON.stringify({ pageAccessToken: 'tok-abc' }) }],
    } as never);

    const result = await getConnectionSecret('conn-1', 'ws-1');

    expect(result).toEqual({ pageAccessToken: 'tok-abc' });
    expect(db).toHaveBeenCalledWith(expect.stringContaining('get_connection_secret'), ['conn-1', 'ws-1']);
  });

  it('rejects cross-tenant access — a real connection_id with the wrong workspace_id fails closed', async () => {
    // The SQL function raises when (connection_id, workspace_id) don't match
    // together; the pg driver surfaces that as a rejected query.
    db.mockRejectedValueOnce(new Error('connection not found for workspace'));

    const result = await getConnectionSecret('conn-owned-by-ws-a', 'ws-b');

    expect(result).toBeNull();
  });

  it('fails closed when the connection has no usable secret', async () => {
    db.mockRejectedValueOnce(new Error('connection has no credentials'));

    const result = await getConnectionSecret('conn-empty', 'ws-1');

    expect(result).toBeNull();
  });

  it('fails closed on a null/empty result without throwing', async () => {
    db.mockResolvedValueOnce({ rows: [{ secret: null }] } as never);

    const result = await getConnectionSecret('conn-1', 'ws-1');

    expect(result).toBeNull();
  });

  it('returns null without querying when connectionId or workspaceId is missing', async () => {
    expect(await getConnectionSecret('', 'ws-1')).toBeNull();
    expect(await getConnectionSecret('conn-1', '')).toBeNull();
    expect(db).not.toHaveBeenCalled();
  });

  it('never throws a raw DB error to the caller', async () => {
    db.mockRejectedValueOnce(new Error('some unexpected db failure with sensitive detail'));

    await expect(getConnectionSecret('conn-1', 'ws-1')).resolves.toBeNull();
  });
});

describe('rotateConnectionSecret', () => {
  it('calls set_connection_secret with the serialized new credentials, updating the pointer', async () => {
    db.mockResolvedValueOnce({ rows: [{ set_connection_secret: 'new-vault-id' }] } as never);

    await rotateConnectionSecret('conn-1', 'ws-1', { pageAccessToken: 'new-token' });

    expect(db).toHaveBeenCalledWith(
      expect.stringContaining('set_connection_secret'),
      ['conn-1', 'ws-1', JSON.stringify({ pageAccessToken: 'new-token' }), expect.stringContaining('conn-1')]
    );
  });

  it('throws when connectionId or workspaceId is missing (fail closed on rotation, never a silent no-op)', async () => {
    await expect(rotateConnectionSecret('', 'ws-1', {})).rejects.toThrow();
    await expect(rotateConnectionSecret('conn-1', '', {})).rejects.toThrow();
    expect(db).not.toHaveBeenCalled();
  });
});
