import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { PgmqQueueAdapter } from '../src/lib/queue/pgmq-adapter';
import { QueueValidationError } from '../src/lib/queue/errors';

const { Client } = pg;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const queueDatabaseUrl = process.env.TEST_QUEUE_DATABASE_URL;
const queueDatabaseTest = queueDatabaseUrl
  ? it
  : process.env.REQUIRE_QUEUE_DATABASE === '1'
    ? it
    : it.skip;

describe('Durable Database Queue Integration Gate', () => {
  queueDatabaseTest('should pass all database-backed pgmq checks', async () => {
    const raw = queueDatabaseUrl;
    if (!raw) {
      throw new Error('TEST_QUEUE_DATABASE_URL is required for the queue database gate');
    }

    const adminUrl = new URL(raw);
    const sourceDb = adminUrl.pathname.slice(1);
    if (!/^(postgres|.*(?:test|temp).*)$/i.test(sourceDb)) {
      throw new Error(`Refusing unsafe admin database name: ${sourceDb}`);
    }

    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const dbName = `ydeck_test_queue_${suffix}`;
    const login = `ydeck_test_queue_login_${suffix}`;
    const runtimeRole = 'ydeck_tenant_runtime_v2';
    const qi = (value: string) => `"${value.replaceAll('"', '""')}"`;

    const admin = new Client({ connectionString: raw });
    let roleExisted = false;
    let dbCreated = false;
    let loginCreated = false;
    let db;

    try {
      await admin.connect();
      
      roleExisted = (await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [runtimeRole])).rowCount === 1;
      if (!roleExisted) {
        await admin.query(`CREATE ROLE ${qi(runtimeRole)} NOLOGIN NOINHERIT`);
      }
      
      await admin.query(`CREATE ROLE ${qi(login)} LOGIN NOINHERIT CREATEROLE`);
      loginCreated = true;
      await admin.query(`GRANT ${qi(login)} TO CURRENT_USER`);
      await admin.query(`GRANT ${qi(runtimeRole)} TO ${qi(login)} WITH ADMIN OPTION`);
      await admin.query(`CREATE DATABASE ${qi(dbName)} OWNER ${qi(login)}`);
      dbCreated = true;

      const testUrl = new URL(raw);
      testUrl.pathname = `/${dbName}`;
      
      db = new Client({ connectionString: testUrl.toString() });
      await db.connect();

      // Run migration 005 as admin/deploy role (in this case, login role)
      await db.query(`SET ROLE ${qi(login)}`);

      // Read migration 005 (Skip schema.sql, 002, 003, 004, and do not create vector extension)
      const migration005 = await readFile(new URL('../src/db/migrations/005_pgmq_queues.sql', import.meta.url), 'utf8');
      await db.query(migration005);

      // Reset role to admin/deploy to test idempotency/rerun of migration
      await db.query('RESET ROLE');
      await db.query(`SET ROLE ${qi(login)}`);
      await db.query(migration005);

      // Verify that queues exist under the admin role (since runtime role cannot direct query pgmq functions like list_queues)
      await db.query('RESET ROLE');
      const queuesRes = await db.query('SELECT queue_name FROM pgmq.list_queues()');
      const queueNames = queuesRes.rows.map(r => r.queue_name);
      expect(queueNames).toContain('inbound_events');
      expect(queueNames).toContain('outbound_messages');

      // Initialize Pgmq Queue Adapter
      const adapter = new PgmqQueueAdapter();

      // Test under SET ROLE ydeck_tenant_runtime_v2
      await db.query(`SET ROLE ${qi(runtimeRole)}`);

      // 1. Send test (inbound_events)
      const testPayload = { v: 1 as const, providerEventId: randomUUID() };
      const msgId = await adapter.send(db, 'inbound_events', testPayload);
      expect(typeof msgId).toBe('bigint');
      expect(msgId).toBeGreaterThan(BigInt(0));

      // 2. Read test (inbound_events)
      // Use 1-second visibility timeout, and wait boundedly for reappearance.
      let msgs = await adapter.read(db, 'inbound_events', { visibilityTimeout: 1, limit: 1 });
      expect(msgs.length).toBe(1);
      expect(msgs[0].messageId).toBe(msgId);
      expect(msgs[0].payload).toEqual(testPayload);
      expect(msgs[0].readCount).toBe(1);

      // 3. Hide test (should return empty immediately after reading)
      const emptyMsgs = await adapter.read(db, 'inbound_events', { limit: 1 });
      expect(emptyMsgs.length).toBe(0);

      // 4. Reappearance and read_ct check
      await sleep(1200); // sleep over 1s visibility timeout
      const reappeared = await adapter.read(db, 'inbound_events', { visibilityTimeout: 5, limit: 1 });
      expect(reappeared.length).toBe(1);
      expect(reappeared[0].messageId).toBe(msgId);
      expect(reappeared[0].readCount).toBe(2);

      // 5. Delete test (inbound_events)
      const deletePayload = { v: 1 as const, providerEventId: randomUUID() };
      const deleteMsgId = await adapter.send(db, 'inbound_events', deletePayload);
      
      const isDeleted = await adapter.delete(db, 'inbound_events', deleteMsgId);
      expect(isDeleted).toBe(true);
      const isDeletedAgain = await adapter.delete(db, 'inbound_events', deleteMsgId);
      expect(isDeletedAgain).toBe(false);

      // Wait 1.1 seconds and verify deleted message does NOT reappear
      await sleep(1100);
      const deletedRead = await adapter.read(db, 'inbound_events', { limit: 5 });
      expect(deletedRead.some(m => m.messageId === deleteMsgId)).toBe(false);

      // 6. Archive test (outbound_messages - test both durable logged queues)
      const archivePayload = { v: 1 as const, outboundJobId: randomUUID() };
      const archiveMsgId = await adapter.send(db, 'outbound_messages', archivePayload);
      
      const isArchived = await adapter.archive(db, 'outbound_messages', archiveMsgId);
      expect(isArchived).toBe(true);
      const isArchivedAgain = await adapter.archive(db, 'outbound_messages', archiveMsgId);
      expect(isArchivedAgain).toBe(false);

      // Verify archived message is not readable
      await sleep(1100);
      const archivedRead = await adapter.read(db, 'outbound_messages', { limit: 5 });
      expect(archivedRead.some(m => m.messageId === archiveMsgId)).toBe(false);

      // Verify under admin role that archive table has it
      await db.query('RESET ROLE');
      const archiveRes = await db.query('SELECT count(*) FROM pgmq.a_outbound_messages WHERE msg_id = $1', [archiveMsgId.toString()]);
      expect(Number(archiveRes.rows[0].count)).toBe(1);
      
      // Return to runtime role
      await db.query(`SET ROLE ${qi(runtimeRole)}`);

      // 7. Batch cap test
      await expect(adapter.read(db, 'inbound_events', { limit: 6 })).rejects.toThrow(QueueValidationError);

      // 8. Transaction rollback of send
      await db.query('BEGIN');
      const rollbackPayload = { v: 1 as const, providerEventId: randomUUID() };
      const rollbackMsgId = await adapter.send(db, 'inbound_events', rollbackPayload);
      await db.query('ROLLBACK');

      // Verify rollback under admin role
      await db.query('RESET ROLE');
      const rollbackCheck = await db.query('SELECT count(*) FROM pgmq.q_inbound_events WHERE msg_id = $1', [rollbackMsgId.toString()]);
      expect(Number(rollbackCheck.rows[0].count)).toBe(0);
      await db.query(`SET ROLE ${qi(runtimeRole)}`);

      // 9. Persistence across reconnect
      const persistentPayload = { v: 1 as const, providerEventId: randomUUID() };
      const persistentMsgId = await adapter.send(db, 'inbound_events', persistentPayload);
      
      await db.end();
      
      db = new Client({ connectionString: testUrl.toString() });
      await db.connect();
      await db.query(`SET ROLE ${qi(runtimeRole)}`);

      // Use 1s visibility timeout and read it
      const persistentRead = await adapter.read(db, 'inbound_events', { visibilityTimeout: 1, limit: 5 });
      expect(persistentRead.some(m => m.messageId === persistentMsgId)).toBe(true);

      // 10. Unauthorized role denial
      await db.query('RESET ROLE');
      const unauthorizedRole = `ydeck_test_unauthorized_${suffix}`;
      await db.query(`CREATE ROLE ${qi(unauthorizedRole)} NOLOGIN`);
      await db.query(`GRANT ${qi(unauthorizedRole)} TO ${qi(login)}`);
      
      await db.query(`SET ROLE ${qi(login)}`);
      await db.query(`SET ROLE ${qi(unauthorizedRole)}`);

      // Use transaction savepoints for expected failures
      await db.query('BEGIN');
      await db.query('SAVEPOINT unauth_test');

      let sendDenied = false;
      try {
        await adapter.send(db, 'inbound_events', { v: 1, providerEventId: randomUUID() });
      } catch (err) {
        sendDenied = true;
      }
      expect(sendDenied).toBe(true);

      await db.query('ROLLBACK TO SAVEPOINT unauth_test');

      let readDenied = false;
      try {
        await adapter.read(db, 'inbound_events');
      } catch (err) {
        readDenied = true;
      }
      expect(readDenied).toBe(true);

      await db.query('ROLLBACK TO SAVEPOINT unauth_test');

      let deleteDenied = false;
      try {
        await adapter.delete(db, 'inbound_events', BigInt(1));
      } catch (err) {
        deleteDenied = true;
      }
      expect(deleteDenied).toBe(true);

      await db.query('ROLLBACK TO SAVEPOINT unauth_test');

      let archiveDenied = false;
      try {
        await adapter.archive(db, 'inbound_events', BigInt(1));
      } catch (err) {
        archiveDenied = true;
      }
      expect(archiveDenied).toBe(true);

      await db.query('ROLLBACK TO SAVEPOINT unauth_test');
      await db.query('COMMIT');

      await db.query('RESET ROLE');
    } finally {
      if (db) {
        try {
          await db.end();
        } catch (_) {}
      }
      
      try {
        if (dbCreated) {
          const cleanupAdmin = new Client({ connectionString: raw });
          await cleanupAdmin.connect();
          await cleanupAdmin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1`, [dbName]);
          await cleanupAdmin.query(`DROP DATABASE IF EXISTS ${qi(dbName)}`);
          
          const unauthorizedRole = `ydeck_test_unauthorized_${suffix}`;
          await cleanupAdmin.query(`DROP ROLE IF EXISTS ${qi(unauthorizedRole)}`);
          await cleanupAdmin.query(`DROP ROLE IF EXISTS ${qi(login)}`);
          if (!roleExisted) {
            await cleanupAdmin.query(`DROP ROLE IF EXISTS ${qi(runtimeRole)}`);
          }
          await cleanupAdmin.end();
        }
      } catch (cleanupError) {
        console.error('Cleanup error:', cleanupError);
      }
      
      try {
        await admin.end();
      } catch (_) {}
    }
  }, 60000);
});
