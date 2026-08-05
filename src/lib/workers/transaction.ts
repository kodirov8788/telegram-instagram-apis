import pool, { DbClient } from '../db';

export type TransactionRunner = <T>(operation: (client: DbClient) => Promise<T>) => Promise<T>;

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

type WorkerTable = 'provider_events' | 'outbound_jobs';

/** Resolve tenant from an ID-only queue reference, then enforce worker RLS for all mutations. */
export const workerRecordTransaction = (table: WorkerTable, id: string): TransactionRunner => async operation => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lookup = await client.query(`SELECT workspace_id FROM public.${table} WHERE id = $1`, [id]);
    const workspaceId = lookup.rows[0]?.workspace_id;
    if (!workspaceId) {
      await client.query('ROLLBACK');
      throw new Error('Worker record not found');
    }
    await client.query('SET LOCAL ROLE ydeck_queue_worker_v1');
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
    const value = await operation(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* connection is already aborting */ }
    throw error;
  } finally { client.release(); }
};
