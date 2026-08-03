import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

const { Client, Pool } = pg;
const raw = process.env.TEST_DATABASE_ADMIN_URL;
if (!raw) throw new Error('Refusing to run: TEST_DATABASE_ADMIN_URL is required (DATABASE_URL is never used)');
const adminUrl = new URL(raw);
const sourceDb = adminUrl.pathname.slice(1);
if (!/^(postgres|.*(?:test|temp).*)$/i.test(sourceDb)) throw new Error(`Refusing unsafe admin database name: ${sourceDb}`);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const dbName = `ydeck_test_${suffix}`;
const login = `ydeck_test_login_${suffix}`;
const runtimeRole = 'ydeck_tenant_runtime_v2';
const qi = value => `"${value.replaceAll('"', '""')}"`;
const admin = new Client({ connectionString: raw });
let roleExisted = false;
let dbCreated = false;
let loginCreated = false;
let db;
let pool;
let tx;
let reused;
let primaryError;

async function expectCount(client, sql, expected, message) {
  const { rows } = await client.query(sql);
  if (Number(rows[0].count) !== expected) throw new Error(`${message}: expected ${expected}, got ${rows[0].count}`);
}

try {
  await admin.connect();
  roleExisted = (await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [runtimeRole])).rowCount === 1;
  if (!roleExisted) await admin.query(`CREATE ROLE ${qi(runtimeRole)} NOLOGIN NOINHERIT`);
  await admin.query(`CREATE ROLE ${qi(login)} LOGIN NOINHERIT CREATEROLE`);
  loginCreated = true;
  await admin.query(`GRANT ${qi(login)} TO CURRENT_USER`);
  await admin.query(`GRANT ${qi(runtimeRole)} TO ${qi(login)} WITH ADMIN OPTION`);
  await admin.query(`CREATE DATABASE ${qi(dbName)} OWNER ${qi(login)}`);
  dbCreated = true;

  const testUrl = new URL(raw); testUrl.pathname = `/${dbName}`;
  // Passwordless/local clusters can SET ROLE to the generated login. Hosted clusters generally
  // cannot create a login with the admin's password, so connect as admin then SET ROLE.
  db = new Client({ connectionString: testUrl.toString() });
  await db.connect();
  await db.query(`SET ROLE ${qi(login)}`);
  const schema = await readFile(new URL('../src/db/schema.sql', import.meta.url), 'utf8');
  const migration = await readFile(new URL('../src/db/migrations/002_auth_rbac_rls.sql', import.meta.url), 'utf8');
  await db.query(schema);
  await db.query(migration);
  await db.query(migration); // idempotency
  await db.query('RESET ROLE');

  const ids = { u1: randomUUID(), u2: randomUUID(), w1: randomUUID(), w2: randomUUID(), c1: randomUUID(), c2: randomUUID(), v1: randomUUID(), v2: randomUUID() };
  await db.query("INSERT INTO users(id,email,full_name) VALUES($1,'one@test.invalid','One'),($2,'two@test.invalid','Two')", [ids.u1,ids.u2]);
  await db.query("INSERT INTO workspaces(id,name) VALUES($1,'One'),($2,'Two')", [ids.w1,ids.w2]);
  await db.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner'),($3,$4,'owner')", [ids.w1,ids.u1,ids.w2,ids.u2]);
  await db.query("INSERT INTO customers(id,workspace_id,full_name) VALUES($1,$2,'One'),($3,$4,'Two')", [ids.c1,ids.w1,ids.c2,ids.w2]);
  await db.query("INSERT INTO conversations(id,workspace_id,customer_id,channel) VALUES($1,$2,$3,'telegram'),($4,$5,$6,'telegram')", [ids.v1,ids.w1,ids.c1,ids.v2,ids.w2,ids.c2]);
  await db.query("INSERT INTO messages(conversation_id,sender,content) VALUES($1,'customer','one'),($2,'customer','two')", [ids.v1,ids.v2]);

  pool = new Pool({ connectionString: testUrl.toString(), max: 1 });
  tx = await pool.connect();
  await tx.query(`SET ROLE ${qi(login)}`);
  await tx.query('BEGIN'); await tx.query(`SET LOCAL ROLE ${qi(runtimeRole)}`); await tx.query("SELECT set_config('app.user_id',$1,true)",[ids.u1]);
  await expectCount(tx, 'SELECT count(*) FROM workspaces', 1, 'cross-tenant workspace read');
  await expectCount(tx, 'SELECT count(*) FROM messages', 1, 'cross-tenant message read');
  await tx.query('ROLLBACK'); tx.release(); tx = undefined;
  reused = await pool.connect();
  const state = await reused.query("SELECT current_role, current_setting('app.user_id',true) AS uid");
  if (state.rows[0].current_role === runtimeRole || state.rows[0].uid) throw new Error('transaction-local role/GUC leaked after rollback/pool reuse');
  await reused.query('BEGIN'); await reused.query(`SET LOCAL ROLE ${qi(runtimeRole)}`); await reused.query("SELECT set_config('app.user_id',$1,true)",[ids.u1]);
  await expectCount(reused, 'SELECT count(*) FROM messages', 1, 'message RLS after pool reuse');
  let denied = false;
  try { await reused.query("INSERT INTO messages(conversation_id,sender,content) VALUES($1,'human_operator','blocked')", [ids.v2]); }
  catch (error) { denied = error?.code === '42501'; }
  if (!denied) throw new Error('cross-tenant message write was not denied by FORCE RLS');
  await reused.query('COMMIT'); reused.release(); reused = undefined; await pool.end(); pool = undefined; await db.end(); db = undefined;
  console.log(`PostgreSQL integration checks passed in isolated database ${dbName}`);
} catch (error) {
  primaryError = error;
} finally {
  const cleanupErrors = [];
  if (tx) { tx.release(true); tx = undefined; }
  if (reused) { reused.release(true); reused = undefined; }
  if (pool) await pool.end().catch(error => cleanupErrors.push(error));
  if (db) await db.end().catch(error => cleanupErrors.push(error));
  try {
    if (dbCreated) { await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1`, [dbName]); await admin.query(`DROP DATABASE IF EXISTS ${qi(dbName)}`); }
    if (roleExisted && loginCreated) await admin.query(`REVOKE ADMIN OPTION FOR ${qi(runtimeRole)} FROM ${qi(login)}`).catch(() => {});
    if (loginCreated) await admin.query(`DROP ROLE IF EXISTS ${qi(login)}`);
    if (!roleExisted) await admin.query(`DROP ROLE IF EXISTS ${qi(runtimeRole)}`);
  } catch (error) { cleanupErrors.push(error); }
  await admin.end().catch(error => cleanupErrors.push(error));
  if (!primaryError && cleanupErrors[0]) primaryError = cleanupErrors[0];
}
if (primaryError) throw primaryError;
