import { beforeEach, describe, expect, it, vi } from 'vitest';

const { query, release, connect } = vi.hoisted(() => ({
  query: vi.fn(),
  release: vi.fn(),
  connect: vi.fn(),
}));

vi.mock('../../db', () => ({ default: { connect } }));

import { runWorkerTransaction } from '../transaction';

describe('runWorkerTransaction', () => {
  beforeEach(() => {
    query.mockReset();
    release.mockReset();
    connect.mockReset();
    connect.mockResolvedValue({ query, release });
  });

  it('commits on success', async () => {
    query.mockResolvedValue({ rows: [] });
    const result = await runWorkerTransaction(async db => {
      await db.query('SELECT 1');
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(query.mock.calls.map(c => c[0])).toEqual(['BEGIN', 'SELECT 1', 'COMMIT']);
    expect(release).toHaveBeenCalledOnce();
  });

  it('rolls back and rethrows on failure', async () => {
    query.mockImplementation(async (text: string) => {
      if (text === 'FAIL') throw new Error('boom');
      return { rows: [] };
    });

    await expect(
      runWorkerTransaction(async db => {
        await db.query('FAIL');
      })
    ).rejects.toThrow('boom');

    expect(query.mock.calls.map(c => c[0])).toEqual(['BEGIN', 'FAIL', 'ROLLBACK']);
    expect(release).toHaveBeenCalledOnce();
  });
});
