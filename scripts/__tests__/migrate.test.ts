import { describe, expect, it, vi } from 'vitest';
import { parsePrefix, runMigrations, type MigrationDbClient } from '../migrate';

describe('parsePrefix', () => {
  it('extracts the leading numeric prefix', () => {
    expect(parsePrefix('013_outbound_job_state_machine.sql')).toBe(13);
    expect(parsePrefix('017_ai_response_idempotency.sql')).toBe(17);
  });

  it('throws on a filename with no numeric prefix', () => {
    expect(() => parsePrefix('README.sql')).toThrow();
  });
});

function makeFakeClient() {
  const applied = new Set<string>();
  let failOn: string | null = null;
  const calls: string[] = [];

  const client: MigrationDbClient = {
    async query(text: string, params?: unknown[]) {
      calls.push(text.trim().slice(0, 40));
      if (text.includes('CREATE TABLE IF NOT EXISTS schema_migrations')) return { rows: [] };
      if (text.trim() === 'SELECT filename FROM schema_migrations') {
        return { rows: Array.from(applied).map(filename => ({ filename })) };
      }
      if (text.trim() === 'BEGIN' || text.trim() === 'COMMIT' || text.trim() === 'ROLLBACK') return { rows: [] };
      if (text.startsWith('INSERT INTO schema_migrations')) {
        const filename = params?.[0] as string;
        if (failOn === filename) throw new Error(`simulated failure applying ${filename}`);
        applied.add(filename);
        return { rows: [] };
      }
      // arbitrary migration SQL body
      return { rows: [] };
    },
  };

  return { client, applied, calls, setFailOn: (f: string | null) => (failOn = f) };
}

describe('runMigrations', () => {
  it('applies pending migrations in order and records them', async () => {
    const { client, applied } = makeFakeClient();
    const migrations = [
      { filename: '002_a.sql', sql: 'SELECT 1;' },
      { filename: '013_b.sql', sql: 'SELECT 1;' },
    ];
    const result = await runMigrations(client, 'SELECT 1;', migrations);
    expect(result.applied).toEqual(['002_a.sql', '013_b.sql']);
    expect(result.skipped).toEqual([]);
    expect(applied.has('002_a.sql')).toBe(true);
    expect(applied.has('013_b.sql')).toBe(true);
  });

  it('is a clean no-op when everything is already applied', async () => {
    const { client } = makeFakeClient();
    const migrations = [{ filename: '002_a.sql', sql: 'SELECT 1;' }];
    await runMigrations(client, 'SELECT 1;', migrations);
    const second = await runMigrations(client, 'SELECT 1;', migrations);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(['002_a.sql']);
  });

  it('stops immediately on failure and does not apply subsequent migrations', async () => {
    const { client, applied, setFailOn } = makeFakeClient();
    setFailOn('013_b.sql');
    const migrations = [
      { filename: '002_a.sql', sql: 'SELECT 1;' },
      { filename: '013_b.sql', sql: 'SELECT 1;' },
      { filename: '014_c.sql', sql: 'SELECT 1;' },
    ];
    await expect(runMigrations(client, 'SELECT 1;', migrations)).rejects.toThrow('simulated failure applying 013_b.sql');
    expect(applied.has('002_a.sql')).toBe(true);
    expect(applied.has('013_b.sql')).toBe(false);
    expect(applied.has('014_c.sql')).toBe(false);
  });

  it('never catches and continues past a failed migration', async () => {
    const { client, setFailOn } = makeFakeClient();
    setFailOn('002_a.sql');
    const querySpy = vi.fn();
    const wrapped: MigrationDbClient = {
      query: (text, params) => {
        querySpy(text);
        return client.query(text, params);
      },
    };
    const migrations = [
      { filename: '002_a.sql', sql: 'SELECT 1;' },
      { filename: '013_b.sql', sql: 'SELECT 1;' },
    ];
    await expect(runMigrations(wrapped, 'SELECT 1;', migrations)).rejects.toThrow();
    const insertCalls = querySpy.mock.calls.filter(([text]) => text.startsWith('INSERT INTO schema_migrations'));
    // Only the failing migration's insert should have been attempted — never 013_b's.
    expect(insertCalls).toHaveLength(1);
  });
});
