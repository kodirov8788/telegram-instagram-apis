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
  const migration006 = await readFile(new URL('../src/db/migrations/006_inbound_data_preflight.sql', import.meta.url), 'utf8');
  const migration007 = await readFile(new URL('../src/db/migrations/007_connection_scoped_customer_identity.sql', import.meta.url), 'utf8');
  await db.query(schema);
  await db.query(migration);
  await db.query(migration); // idempotency
  const getIdentityMetadata = async () => (await db.query(`
    SELECT 'constraint' AS kind, conname AS name, pg_get_constraintdef(oid) AS definition
    FROM pg_constraint WHERE conrelid IN ('public.customers'::regclass,'public.channel_connections'::regclass)
      AND conname IN ('channel_connections_id_workspace_unique','customers_connection_tenant_fk')
    UNION ALL
    SELECT 'index', indexname, indexdef FROM pg_indexes
      WHERE schemaname='public' AND indexname='customers_connection_provider_identity_unique'
    UNION ALL
    SELECT 'function', proname, pg_get_function_identity_arguments(oid) FROM pg_proc
      WHERE oid='public.upsert_connection_customer(uuid,public.channel_type,text,text,text)'::regprocedure
    ORDER BY kind,name
  `)).rows;
  const freshIdentityMetadata = await getIdentityMetadata();
  if (freshIdentityMetadata.length !== 4) throw new Error(`fresh issue 57 schema incomplete: ${JSON.stringify(freshIdentityMetadata)}`);
  await db.query(`
    DROP FUNCTION public.upsert_connection_customer(UUID, public.channel_type, TEXT, TEXT, TEXT);
    DROP INDEX public.customers_connection_provider_identity_unique;
    ALTER TABLE public.customers DROP CONSTRAINT customers_connection_tenant_fk;
    ALTER TABLE public.channel_connections DROP CONSTRAINT channel_connections_id_workspace_unique;
  `);
  await db.query(`
    ALTER TABLE public.customers DROP COLUMN connection_id, DROP COLUMN provider_user_id;
    ALTER TABLE public.conversations DROP COLUMN connection_id;
    ALTER TABLE public.messages DROP COLUMN workspace_id, DROP COLUMN provider_event_id;
  `);
  await db.query(migration006);
  await db.query(migration006); // idempotency on a migrated schema
  const inboundColumns = await db.query(`
    SELECT table_name, column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public' AND (
      (table_name = 'customers' AND column_name IN ('connection_id', 'provider_user_id')) OR
      (table_name = 'conversations' AND column_name = 'connection_id') OR
      (table_name = 'messages' AND column_name IN ('workspace_id', 'provider_event_id'))
    ) ORDER BY table_name, column_name
  `);
  const expectedInboundColumns = [
    ['conversations', 'connection_id', 'uuid'],
    ['customers', 'connection_id', 'uuid'],
    ['customers', 'provider_user_id', 'text'],
    ['messages', 'provider_event_id', 'uuid'],
    ['messages', 'workspace_id', 'uuid'],
  ];
  if (inboundColumns.rowCount !== expectedInboundColumns.length || inboundColumns.rows.some((row, index) =>
    row.table_name !== expectedInboundColumns[index][0] ||
    row.column_name !== expectedInboundColumns[index][1] ||
    row.data_type !== expectedInboundColumns[index][2] ||
    row.is_nullable !== 'YES'
  )) throw new Error(`migration 006 schema parity failed: ${JSON.stringify(inboundColumns.rows)}`);
  await db.query('RESET ROLE');

  const attrs = (await db.query('SELECT rolcanlogin,rolinherit,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolreplication FROM pg_roles WHERE rolname=$1', [runtimeRole])).rows[0];
  if (!attrs || attrs.rolcanlogin || attrs.rolinherit || attrs.rolsuper || attrs.rolbypassrls || attrs.rolcreatedb || attrs.rolcreaterole || attrs.rolreplication) throw new Error('runtime role retained dangerous attributes');

  const ids = { u1: randomUUID(), u2: randomUUID(), u3: randomUUID(), w1: '', w2: randomUUID(), c1: randomUUID(), c2: randomUUID(), v1: randomUUID(), v2: randomUUID() };
  await db.query("INSERT INTO users(id,email,full_name) VALUES($1,'one@test.invalid','One'),($2,'two@test.invalid','Two'),($3,'invitee@test.invalid','Invitee')", [ids.u1,ids.u2,ids.u3]);
  await db.query(`SET ROLE ${qi(login)}`);
  await db.query('BEGIN'); await db.query("SELECT set_config('app.user_id',$1,true)", [ids.u1]);
  const bootstrapped = await db.query("SELECT id FROM bootstrap_workspace('One','general','UTC','en',$1::jsonb)", [JSON.stringify({ start: '09:00', end: '18:00', days: [1,2,3,4,5] })]);
  ids.w1 = bootstrapped.rows[0]?.id;
  if (!ids.w1) throw new Error('workspace bootstrap returned no workspace');
  await db.query('COMMIT'); await db.query('RESET ROLE');
  await db.query("INSERT INTO workspaces(id,name) VALUES($1,'Two')", [ids.w2]);
  await db.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')", [ids.w2,ids.u2]);
  await expectCount(db, `SELECT count(*) FROM workspace_members WHERE workspace_id='${ids.w1}' AND user_id='${ids.u1}' AND role='owner'`, 1, 'workspace bootstrap owner membership');

  const invitationHash = 'a'.repeat(64);
  await db.query("INSERT INTO workspace_invitations(workspace_id,email,role,token_hash,invited_by,expires_at) VALUES($1,'invitee@test.invalid','support_operator',$2,$3,NOW()+INTERVAL '1 hour')", [ids.w1,invitationHash,ids.u1]);
  await db.query(`SET ROLE ${qi(login)}`);
  await db.query('BEGIN'); await db.query("SELECT set_config('app.user_id',$1,true)", [ids.u3]);
  const accepted = await db.query('SELECT * FROM accept_workspace_invitation($1)', [invitationHash]);
  if (accepted.rowCount !== 1 || accepted.rows[0].workspace_id !== ids.w1 || accepted.rows[0].role !== 'support_operator') throw new Error('valid invitation was not accepted');
  await db.query('COMMIT');
  await db.query('BEGIN'); await db.query("SELECT set_config('app.user_id',$1,true)", [ids.u3]);
  const replay = await db.query('SELECT * FROM accept_workspace_invitation($1)', [invitationHash]);
  if (replay.rowCount !== 0) throw new Error('accepted invitation replay was not rejected');
  await db.query('ROLLBACK'); await db.query('RESET ROLE');
  await db.query("INSERT INTO customers(id,workspace_id,full_name) VALUES($1,$2,'One'),($3,$4,'Two')", [ids.c1,ids.w1,ids.c2,ids.w2]);
  await db.query("INSERT INTO conversations(id,workspace_id,customer_id,channel) VALUES($1,$2,$3,'telegram'),($4,$5,$6,'telegram')", [ids.v1,ids.w1,ids.c1,ids.v2,ids.w2,ids.c2]);
  await db.query("INSERT INTO messages(conversation_id,sender,content) VALUES($1,'customer','one'),($2,'customer','two')", [ids.v1,ids.v2]);

  const preflight = {
    workspace: randomUUID(), ambiguousWorkspace: randomUUID(),
    connection: randomUUID(), ambiguousConnection1: randomUUID(), ambiguousConnection2: randomUUID(),
    instagramConnection: randomUUID(), customer: randomUUID(), instagramCustomer: randomUUID(),
    conflictingCustomer: randomUUID(), ambiguousCustomer: randomUUID(), dualCustomer: randomUUID(),
    conversation: randomUUID(), ambiguousConversation: randomUUID(), message: randomUUID(),
  };
  await db.query("INSERT INTO workspaces(id,name) VALUES($1,'Preflight'),($2,'Ambiguous preflight')", [preflight.workspace, preflight.ambiguousWorkspace]);
  await db.query("INSERT INTO channel_connections(id,workspace_id,channel,account_identifier,credentials,is_active) VALUES($1,$2,'telegram','single','{}',true),($3,$2,'instagram','instagram-single','{}',true),($4,$5,'telegram','ambiguous-1','{}',true),($6,$5,'telegram','ambiguous-2','{}',true)", [preflight.connection, preflight.workspace, preflight.instagramConnection, preflight.ambiguousConnection1, preflight.ambiguousWorkspace, preflight.ambiguousConnection2]);
  await db.query("INSERT INTO customers(id,workspace_id,full_name,telegram_id) VALUES($1,$2,'Single','provider-single'),($3,$4,'Ambiguous','provider-ambiguous')", [preflight.customer, preflight.workspace, preflight.ambiguousCustomer, preflight.ambiguousWorkspace]);
  await db.query("INSERT INTO customers(id,workspace_id,full_name,instagram_id) VALUES($1,$2,'Instagram','instagram-provider')", [preflight.instagramCustomer, preflight.workspace]);
  await db.query("INSERT INTO customers(id,workspace_id,full_name,telegram_id,connection_id) VALUES($1,$2,'Conflicting','provider-conflict',$3)", [preflight.conflictingCustomer, preflight.workspace, preflight.ambiguousConnection1]);
  await db.query("INSERT INTO customers(id,workspace_id,full_name,telegram_id,instagram_id) VALUES($1,$2,'Dual','telegram-dual','instagram-dual')", [preflight.dualCustomer, preflight.workspace]);
  await db.query("INSERT INTO conversations(id,workspace_id,customer_id,channel) VALUES($1,$2,$3,'telegram'),($4,$5,$6,'telegram')", [preflight.conversation, preflight.workspace, preflight.customer, preflight.ambiguousConversation, preflight.ambiguousWorkspace, preflight.ambiguousCustomer]);
  await db.query("INSERT INTO messages(id,conversation_id,sender,content) VALUES($1,$2,'customer','preflight')", [preflight.message, preflight.conversation]);
  await db.query(migration006);
  await db.query(migration006); // populated backfill rerun
  const preflightRows = await db.query(`
    SELECT
      (SELECT connection_id FROM customers WHERE id=$1) AS customer_connection,
      (SELECT provider_user_id FROM customers WHERE id=$1) AS customer_provider,
      (SELECT connection_id FROM customers WHERE id=$2) AS instagram_customer_connection,
      (SELECT provider_user_id FROM customers WHERE id=$2) AS instagram_customer_provider,
      (SELECT connection_id FROM customers WHERE id=$3) AS conflicting_customer_connection,
      (SELECT provider_user_id FROM customers WHERE id=$3) AS conflicting_customer_provider,
      (SELECT connection_id FROM customers WHERE id=$4) AS ambiguous_customer_connection,
      (SELECT provider_user_id FROM customers WHERE id=$4) AS ambiguous_customer_provider,
      (SELECT connection_id FROM customers WHERE id=$5) AS dual_customer_connection,
      (SELECT connection_id FROM conversations WHERE id=$6) AS conversation_connection,
      (SELECT connection_id FROM conversations WHERE id=$7) AS ambiguous_conversation_connection,
      (SELECT workspace_id FROM messages WHERE id=$8) AS message_workspace
  `, [preflight.customer, preflight.instagramCustomer, preflight.conflictingCustomer, preflight.ambiguousCustomer, preflight.dualCustomer, preflight.conversation, preflight.ambiguousConversation, preflight.message]);
  const result = preflightRows.rows[0];
  if (result.customer_connection !== preflight.connection || result.customer_provider !== 'provider-single' ||
      result.instagram_customer_connection !== preflight.instagramConnection || result.instagram_customer_provider !== 'instagram-provider' ||
      result.conflicting_customer_connection !== preflight.ambiguousConnection1 || result.conflicting_customer_provider !== null ||
      result.ambiguous_customer_connection !== null || result.ambiguous_customer_provider !== null ||
      result.dual_customer_connection !== null || result.conversation_connection !== preflight.connection ||
      result.ambiguous_conversation_connection !== null || result.message_workspace !== preflight.workspace) {
    throw new Error(`migration 006 safe backfill failed: ${JSON.stringify(result)}`);
  }

  await db.query('DELETE FROM customers WHERE id=$1', [preflight.conflictingCustomer]);
  await db.query(migration007);
  await db.query(migration007); // migration rerun
  const migratedIdentityMetadata = await getIdentityMetadata();
  if (JSON.stringify(migratedIdentityMetadata) !== JSON.stringify(freshIdentityMetadata)) {
    throw new Error(`issue 57 fresh/migrated schema mismatch: fresh=${JSON.stringify(freshIdentityMetadata)} migrated=${JSON.stringify(migratedIdentityMetadata)}`);
  }

  const identityConnections = { first: randomUUID(), second: randomUUID(), otherTenant: randomUUID() };
  await db.query("INSERT INTO channel_connections(id,workspace_id,channel,account_identifier,credentials,is_active) VALUES($1,$2,'telegram','identity-1','{}',true),($3,$2,'telegram','identity-2','{}',true),($4,$5,'telegram','identity-other','{}',true)", [identityConnections.first, ids.w1, identityConnections.second, identityConnections.otherTenant, ids.w2]);

  pool = new Pool({ connectionString: testUrl.toString(), max: 8 });
  const runtimeUpsert = async (userId, connectionId, provider, providerUserId) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE ${qi(runtimeRole)}`);
      await client.query("SELECT set_config('app.user_id',$1,true)", [userId]);
      const result = await client.query('SELECT id,workspace_id,connection_id,provider_user_id FROM upsert_connection_customer($1,$2,$3,$4,$5)', [connectionId, provider, providerUserId, 'Concurrent customer', 'concurrent']);
      await client.query('COMMIT');
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  };
  const concurrentCustomers = await Promise.all(Array.from({ length: 8 }, () => runtimeUpsert(ids.u1, identityConnections.first, 'telegram', 'same-user')));
  if (new Set(concurrentCustomers.map(customer => customer.id)).size !== 1) throw new Error('concurrent identity upsert returned multiple customers');
  await expectCount(db, `SELECT count(*) FROM customers WHERE workspace_id='${ids.w1}' AND connection_id='${identityConnections.first}' AND provider_user_id='same-user'`, 1, 'concurrent identity uniqueness');
  const isolatedCustomer = await runtimeUpsert(ids.u1, identityConnections.second, 'telegram', 'same-user');
  if (isolatedCustomer.id === concurrentCustomers[0].id) throw new Error('provider user identity leaked across connections');
  for (const [message, operation, expectedCode] of [
    ['provider mismatch accepted', () => runtimeUpsert(ids.u1, identityConnections.first, 'instagram', 'provider-mismatch'), '23503'],
    ['tenant mismatch accepted', () => runtimeUpsert(ids.u1, identityConnections.otherTenant, 'telegram', 'tenant-mismatch'), '42501'],
  ]) {
    let code;
    try { await operation(); } catch (error) { code = error?.code; }
    if (code !== expectedCode) throw new Error(`${message}: expected ${expectedCode}, got ${code}`);
  }
  const direct = await pool.connect();
  try {
    await direct.query('BEGIN'); await direct.query(`SET LOCAL ROLE ${qi(runtimeRole)}`); await direct.query("SELECT set_config('app.user_id',$1,true)", [ids.u1]);
    for (const statement of [
      ["INSERT INTO customers(workspace_id,full_name) VALUES($1,'blocked')", [ids.w1]],
      ["UPDATE customers SET full_name='blocked' WHERE id=$1", [concurrentCustomers[0].id]],
      ["DELETE FROM customers WHERE id=$1", [concurrentCustomers[0].id]],
    ]) {
      await direct.query('SAVEPOINT direct_customer_mutation');
      let denied = false;
      try { await direct.query(statement[0], statement[1]); } catch (error) { denied = error?.code === '42501'; await direct.query('ROLLBACK TO SAVEPOINT direct_customer_mutation'); }
      await direct.query('RELEASE SAVEPOINT direct_customer_mutation');
      if (!denied) throw new Error('runtime direct customer mutation was not denied');
    }
    await direct.query('ROLLBACK');
  } finally { direct.release(); }
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
    if (dbCreated) await admin.query(`DROP DATABASE IF EXISTS ${qi(dbName)} WITH (FORCE)`);
    if (roleExisted && loginCreated) await admin.query(`REVOKE ADMIN OPTION FOR ${qi(runtimeRole)} FROM ${qi(login)}`).catch(() => {});
    if (loginCreated) await admin.query(`DROP ROLE IF EXISTS ${qi(login)}`);
    if (!roleExisted) await admin.query(`DROP ROLE IF EXISTS ${qi(runtimeRole)}`);
  } catch (error) { cleanupErrors.push(error); }
  await admin.end().catch(error => cleanupErrors.push(error));
  if (!primaryError && cleanupErrors[0]) primaryError = cleanupErrors[0];
}
if (primaryError) throw primaryError;
