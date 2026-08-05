import { beforeEach, describe, expect, it, vi } from 'vitest';

const { query, release } = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn() }));

vi.mock('../../db', () => ({
  default: { connect: vi.fn().mockResolvedValue({ query, release }) },
}));

import { workerRecordTransaction } from '../transaction';

describe('workerRecordTransaction', () => {
  beforeEach(() => {
    query.mockReset();
    release.mockReset();
  });

  it('derives the workspace from the outbound job before running work under the worker role', async () => {
    query.mockImplementation(async (text: string) => {
      if (text.includes('SELECT workspace_id')) return { rows: [{ workspace_id: 'workspace-1' }] };
      if (text.includes('SELECT credentials')) return { rows: [{ credentials: { bot_token: 'token' } }] };
      return { rows: [] };
    });

    const transaction = workerRecordTransaction('outbound_jobs', 'job-1');
    await transaction(db => db.query(
      `SELECT credentials FROM channel_connections
       WHERE id = $1 AND workspace_id = $2 AND channel = $3 AND is_active IS TRUE`,
      ['connection-1', 'workspace-1', 'telegram']
    ));

    expect(query.mock.calls.map(call => call[0])).toEqual([
      'BEGIN',
      'SELECT workspace_id FROM public.outbound_jobs WHERE id = $1',
      'SET LOCAL ROLE ydeck_queue_worker_v1',
      "SELECT set_config('app.workspace_id', $1, true)",
      expect.stringContaining('SELECT credentials FROM channel_connections'),
      'COMMIT',
    ]);
    expect(query.mock.calls[1][1]).toEqual(['job-1']);
    expect(query.mock.calls[3][1]).toEqual(['workspace-1']);
    expect(query.mock.calls[4][1]).toEqual(['connection-1', 'workspace-1', 'telegram']);
    expect(query.mock.calls[4][0]).toContain('is_active IS TRUE');
    expect(release).toHaveBeenCalledOnce();
  });
});
