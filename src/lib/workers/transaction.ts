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
