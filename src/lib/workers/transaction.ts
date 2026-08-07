import pool, { DbClient } from '../db';

export type TransactionRunner = <T>(operation: (client: DbClient) => Promise<T>) => Promise<T>;

/**
 * Plain BEGIN/COMMIT/ROLLBACK transaction for worker code, mirroring the
 * shape of `identityTransaction` in `src/lib/db.ts`. No role switch: the
 * pool already connects as the application's privileged DB role (same as
 * every other service in this codebase, e.g. `ai-intelligence.ts`), so
 * there is no separate worker role to assume here.
 */
export const runWorkerTransaction: TransactionRunner = async operation => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const value = await operation(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

/** Convenience alias for the queue read/send/delete/archive calls in runtime.ts — same transaction shape. */
export const queueWorkerTransaction = runWorkerTransaction;
