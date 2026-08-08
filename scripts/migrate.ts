// scripts/migrate.ts
//
// Production migration runner for issue #36 (partial scope).
//
// Behavior:
//   1. Applies src/db/schema.sql (idempotent — every statement in it uses
//      CREATE TABLE/INDEX/... IF NOT EXISTS, confirmed by inspection).
//   2. Applies every src/db/migrations/*.sql file, in deterministic order
//      (sorted by the leading numeric prefix, then by filename as a
//      tie-breaker for the two files that currently share prefix "017" —
//      see the PR description for why that's safe).
//   3. Tracks applied migrations in a `schema_migrations` table so a
//      migration is only ever executed once, even though the migrations
//      themselves are also written to be idempotent (belt + suspenders —
//      a tracking table is the standard, safe choice for a real deploy
//      pipeline and is a small addition on top of already-idempotent SQL).
//   4. Fails fast: the moment one migration throws, the runner stops,
//      prints the error, and exits non-zero. It does not catch-and-continue
//      and does not attempt subsequent migrations.
//   5. Safe to run repeatedly: with nothing pending it is a clean no-op,
//      exit code 0.
//
// Connection: reuses the DATABASE_URL convention from src/lib/db.ts. No
// connection details are hardcoded here.
//
// Usage:
//   DATABASE_URL=postgres://... npx tsx scripts/migrate.ts

import 'dotenv/config';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, '..', 'src', 'db', 'schema.sql');
const MIGRATIONS_DIR = path.join(__dirname, '..', 'src', 'db', 'migrations');

interface MigrationFile {
  filename: string;
  prefix: number;
  fullPath: string;
}

/** Parses the leading numeric prefix of a migration filename, e.g. "013" from "013_outbound_job_state_machine.sql". */
export function parsePrefix(filename: string): number {
  const match = filename.match(/^(\d+)_/);
  if (!match) throw new Error(`Migration filename "${filename}" has no leading numeric prefix`);
  return Number.parseInt(match[1], 10);
}

/**
 * Deterministic order: sort by numeric prefix first, then by filename as a
 * tie-breaker (two migrations currently share prefix "017" — this keeps a
 * stable, reproducible order regardless of filesystem listing order).
 */
export function sortMigrationFiles(filenames: string[]): MigrationFile[] {
  return filenames
    .filter(name => name.endsWith('.sql'))
    .map(filename => ({ filename, prefix: parsePrefix(filename), fullPath: path.join(MIGRATIONS_DIR, filename) }))
    .sort((a, b) => (a.prefix !== b.prefix ? a.prefix - b.prefix : a.filename.localeCompare(b.filename)));
}

export interface MigrationDbClient {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

const TRACKING_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`;

async function ensureTrackingTable(client: MigrationDbClient): Promise<void> {
  await client.query(TRACKING_TABLE_DDL);
}

async function getAppliedMigrations(client: MigrationDbClient): Promise<Set<string>> {
  const { rows } = await client.query('SELECT filename FROM schema_migrations');
  return new Set(rows.map(row => row.filename as string));
}

async function applyOne(client: MigrationDbClient, filename: string, sql: string): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

/**
 * Core runner logic, decoupled from process/env/fs concerns so it's
 * testable with an injected client and file list.
 */
export async function runMigrations(
  client: MigrationDbClient,
  schemaSql: string,
  migrations: { filename: string; sql: string }[],
  log: (msg: string) => void = () => {},
): Promise<{ applied: string[]; skipped: string[] }> {
  await ensureTrackingTable(client);

  // schema.sql itself is idempotent (IF NOT EXISTS throughout) and is not
  // tracked in schema_migrations — it's the baseline, not a numbered step.
  await client.query(schemaSql);

  const applied: string[] = [];
  const alreadyApplied = await getAppliedMigrations(client);
  const skipped: string[] = [];

  for (const migration of migrations) {
    if (alreadyApplied.has(migration.filename)) {
      skipped.push(migration.filename);
      log(`skip  ${migration.filename} (already applied)`);
      continue;
    }
    log(`apply ${migration.filename}`);
    try {
      await applyOne(client, migration.filename, migration.sql);
    } catch (error) {
      log(`FAIL  ${migration.filename}: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
    applied.push(migration.filename);
  }

  return { applied, skipped };
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is required to run migrations.');
    process.exitCode = 1;
    return;
  }

  const schemaSql = await readFile(SCHEMA_PATH, 'utf8');
  const files = await readdir(MIGRATIONS_DIR);
  const sortedFiles = sortMigrationFiles(files);
  const migrations = await Promise.all(
    sortedFiles.map(async file => ({ filename: file.filename, sql: await readFile(file.fullPath, 'utf8') })),
  );

  const client = new Client({
    connectionString,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });
  await client.connect();

  try {
    const { applied, skipped } = await runMigrations(client, schemaSql, migrations, msg => console.log(msg));
    console.log(`\nMigration run complete: ${applied.length} applied, ${skipped.length} already up to date.`);
  } catch (error) {
    console.error('\nMigration run FAILED — stopping, no further migrations applied.');
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

// Only run when executed directly (not when imported for tests).
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch(error => {
    console.error('Unhandled error in migration runner:', error);
    process.exitCode = 1;
  });
}
