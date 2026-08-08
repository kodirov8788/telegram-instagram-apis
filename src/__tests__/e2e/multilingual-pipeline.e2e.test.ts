/**
 * Consolidated multilingual end-to-end test for the messaging pipeline
 * (issue #50).
 *
 * SCOPE: exercises the FULL chain against a real, disposable Postgres —
 * authenticated webhook -> tenant resolution -> provider-event dedup ->
 * inbound pgmq queue -> inbound worker -> classification -> RAG ->
 * mode-routing -> outbound job -> outbound pgmq queue -> outbound worker ->
 * final delivery state. Every layer in that chain runs for real: real HTTP
 * route handlers (via NextRequest), real SQL (schema.sql + all
 * src/db/migrations/*.sql applied to a throwaway database), real pgmq
 * queue read/claim/delete, real worker logic (`processWorkerBatch`,
 * `processInboundEvent`, `processOutboundJob`).
 *
 * MOCKING BOUNDARY (the only two things mocked — the true external edges):
 *   1. The LLM call. `AIClassifierService`/`KnowledgeBaseService` both
 *      already fall back to deterministic, non-network code paths when
 *      `OPENAI_API_KEY` is unset (see src/lib/services/ai-classifier.ts's
 *      rule-based fallback and knowledge-base.ts's keyword-filter
 *      fallback) — this test relies on that existing seam instead of
 *      reimplementing an LLM mock, by never setting the key. This also
 *      keeps language detection deterministic across the 3 languages
 *      under test (uz default / ru via Cyrillic / en via keyword match).
 *   2. The outbound provider HTTP call. `TelegramService.prototype.sendMessage`
 *      is replaced with `vi.spyOn` per-scenario (resolve / reject with a
 *      typed `ProviderDeliveryError`) so retry/permanent-failure scenarios
 *      are deterministic without ever hitting api.telegram.org. Instagram's
 *      HTTP path is symmetric and already covered by
 *      src/app/api/__tests__/instagram-webhook.test.ts at the unit level,
 *      so this file drives every scenario through the Telegram route to
 *      keep the matrix small (per the issue's "smallest real test" scope);
 *      only the LLM/provider boundary above is mocked here, deliberately
 *      including the Instagram webhook's own signature auth is NOT
 *      exercised in this file.
 *
 * Everything else — webhook secret-token auth, tenant resolution, DB
 * writes, provider_events dedup, pgmq enqueue/claim, worker retry/backoff,
 * mode routing (auto/approval/suggestion/human), outbound_jobs state
 * machine — runs unmocked against the live database.
 *
 * HOW TO RUN:
 *   1. Start a disposable Postgres (matches src/db root of this repo):
 *
 *        export DOCKER_HOST=unix:///Users/Kodirovdev/.colima/default/docker.sock
 *        docker run --rm -d --name pg50-e2e -e POSTGRES_PASSWORD=postgres \
 *          -e POSTGRES_DB=postgres -p 55600:5432 supabase/postgres:15.14.1.160
 *        sleep 8
 *
 *   2. Run this file only, with RUN_E2E=1 (it is skipped otherwise, so a
 *      plain `npm test` never needs Docker):
 *
 *        RUN_E2E=1 npx vitest run src/__tests__/e2e/multilingual-pipeline.e2e.test.ts
 *
 *      Optionally point at a different admin connection via
 *      E2E_DATABASE_ADMIN_URL (defaults to
 *      postgresql://postgres:postgres@localhost:55600/postgres). The test
 *      creates and drops its own throwaway database per run — it never
 *      touches the `postgres` database's data directly.
 *
 *   3. Tear down when done: `docker rm -f pg50-e2e`.
 */
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ProviderDeliveryError } from '@/lib/services/provider-delivery-error';

const RUN_E2E = process.env.RUN_E2E === '1';
const ADMIN_URL = process.env.E2E_DATABASE_ADMIN_URL || 'postgresql://postgres:postgres@localhost:55600/postgres';

describe.skipIf(!RUN_E2E)('Multilingual pipeline e2e (issue #50)', () => {
  let adminClient: Client;
  let dbName: string;
  let dbUrl: string;

  // All resolved dynamically in beforeAll, AFTER process.env.DATABASE_URL
  // is set — every one of these modules (transitively) constructs the `pg`
  // Pool from src/lib/db.ts at import time, so importing any of them
  // before the env var is set would silently point at the wrong database.
  let query: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
  let pool: { end: () => Promise<void> };
  let telegramPOST: (req: NextRequest) => Promise<Response>;
  let processWorkerBatch: (opts: any) => Promise<number>;
  let processInboundEvent: (id: string) => Promise<{ outcome: string }>;
  let processOutboundJob: (id: string) => Promise<{ outcome: string }>;
  let TelegramService: any;
  let resolveAmbiguousJob: (jobId: string, resolution: 'confirmed_delivered' | 'confirmed_not_delivered' | 'abandon') => Promise<unknown>;
  let enqueueOutboundJob: (client: { query: typeof query }, jobId: string) => Promise<void>;

  beforeAll(async () => {
    adminClient = new Client({ connectionString: ADMIN_URL });
    await adminClient.connect();

    dbName = `ydeck_e2e_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await adminClient.query(`CREATE DATABASE "${dbName}"`);

    const url = new URL(ADMIN_URL);
    url.pathname = `/${dbName}`;
    dbUrl = url.toString();

    // Apply schema.sql + every migration in filename order, as the
    // superuser admin connection — this bypasses the runtime-role GRANT
    // scoping migration 002+ set up (superuser bypasses ACL checks
    // entirely), which is fine here: this test only needs the schema to
    // exist and function correctly, not to re-verify the RBAC/RLS grant
    // model itself (that's covered elsewhere, e.g. tenant-security.test.ts).
    const setupClient = new Client({ connectionString: dbUrl });
    await setupClient.connect();
    const repoRoot = path.resolve(__dirname, '../../..');
    const schema = await readFile(path.join(repoRoot, 'src/db/schema.sql'), 'utf8');
    await setupClient.query(schema);
    const migrationsDir = path.join(repoRoot, 'src/db/migrations');
    const migrationFiles = (await readdir(migrationsDir)).filter(f => f.endsWith('.sql')).sort();
    for (const file of migrationFiles) {
      const sql = await readFile(path.join(migrationsDir, file), 'utf8');
      await setupClient.query(sql);
    }
    await setupClient.end();

    process.env.DATABASE_URL = dbUrl;
    // Deliberately never set OPENAI_API_KEY — see the mocking-boundary doc
    // comment above.
    delete process.env.OPENAI_API_KEY;

    ({ query, default: pool } = await import('@/lib/db'));
    ({ POST: telegramPOST } = await import('@/app/api/webhooks/telegram/route'));
    ({ processWorkerBatch } = await import('@/lib/workers/runtime'));
    ({ processInboundEvent } = await import('@/lib/workers/processors/inbound'));
    ({ processOutboundJob } = await import('@/lib/workers/processors/outbound'));
    ({ TelegramService } = await import('@/lib/services/telegram'));
    ({ resolveAmbiguousJob, enqueueOutboundJob } = await import('@/lib/services/outbound-jobs'));
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    try {
      await adminClient.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    } finally {
      await adminClient.end();
    }
  });

  let sendSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.restoreAllMocks();
    sendSpy = vi.spyOn(TelegramService.prototype, 'sendMessage').mockResolvedValue({
      providerMessageId: `tg-${randomUUID()}`,
      raw: {},
    });
  });

  // ---- fixtures -----------------------------------------------------

  async function seedWorkspace() {
    const workspaceId = (await query(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [`ws-${randomUUID()}`]))
      .rows[0].id as string;
    const identifier = `bot_${randomUUID().slice(0, 8)}`;
    const secret = `whsec_${randomUUID()}`;
    const connectionId = (
      await query(
        `INSERT INTO channel_connections (workspace_id, channel, account_identifier, credentials, is_active)
         VALUES ($1, 'telegram', $2, $3::jsonb, true) RETURNING id`,
        [workspaceId, identifier, JSON.stringify({ botToken: 'test-bot-token', webhookSecret: secret })]
      )
    ).rows[0].id as string;
    return { workspaceId, connectionId, identifier, secret };
  }

  async function seedApprovedKnowledge(workspaceId: string, language: 'uz' | 'ru' | 'en', content: string) {
    await query(
      `INSERT INTO knowledge_items (workspace_id, title, content, category, language, is_approved)
       VALUES ($1, 'FAQ', $2, 'faq', $3, true)`,
      [workspaceId, content, language]
    );
  }

  function telegramUpdate(updateId: number, fromId: number, text: string) {
    return {
      update_id: updateId,
      message: {
        message_id: updateId,
        from: { id: fromId, is_bot: false, first_name: 'Test', username: `user${fromId}` },
        chat: { id: fromId, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text,
      },
    };
  }

  async function postTelegram(identifier: string, secret: string, payload: unknown) {
    const req = new NextRequest(`https://app.test/api/webhooks/telegram?connection=${identifier}`, {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: { 'x-telegram-bot-api-secret-token': secret },
    });
    return telegramPOST(req);
  }

  /** Drains the inbound_events queue for real (bounded — never loops forever on a stuck fixture). */
  async function drainInbound(maxBatches = 5) {
    for (let i = 0; i < maxBatches; i++) {
      const n = await processWorkerBatch({ queue: 'inbound_events', process: processInboundEvent });
      if (n === 0) return;
    }
  }

  /** Drains the outbound_jobs queue for real. */
  async function drainOutbound(maxBatches = 5) {
    for (let i = 0; i < maxBatches; i++) {
      const n = await processWorkerBatch({ queue: 'outbound_jobs', process: processOutboundJob });
      if (n === 0) return;
    }
  }

  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  // ---- scenarios ------------------------------------------------------

  it.each([
    ['uz', "Salom, narxi qancha?", 'Narxi 100000 som.'],
    ['ru', 'Здравствуйте, сколько это стоит?', 'Цена 100000 сум.'],
    ['en', 'Hello, how much does it cost?', 'The price is 100000 sum.'],
  ] as const)('scenario 1: auto response reaches sent delivery state (%s)', async (language, customerText, kbAnswer) => {
    const ws = await seedWorkspace();
    await seedApprovedKnowledge(ws.workspaceId, language, kbAnswer);

    const res = await postTelegram(ws.identifier, ws.secret, telegramUpdate(1, 5001, customerText));
    expect(res.status).toBe(200);

    await drainInbound();
    await drainOutbound();

    const conv = await query(`SELECT mode, detected_language FROM conversations WHERE workspace_id = $1`, [ws.workspaceId]);
    expect(conv.rows).toHaveLength(1);
    expect(conv.rows[0].mode).toBe('auto');
    expect(conv.rows[0].detected_language).toBe(language);

    const aiMsg = await query(
      `SELECT content, delivery_status FROM messages WHERE conversation_id = (SELECT id FROM conversations WHERE workspace_id=$1) AND sender = 'ai'`,
      [ws.workspaceId]
    );
    expect(aiMsg.rows).toHaveLength(1);
    expect(aiMsg.rows[0].delivery_status).toBe('sent');
    expect(aiMsg.rows[0].content).toContain(kbAnswer);

    const job = await query(`SELECT status FROM outbound_jobs WHERE workspace_id = $1`, [ws.workspaceId]);
    expect(job.rows).toHaveLength(1);
    expect(job.rows[0].status).toBe('sent');
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it('scenario 2: approval mode creates a draft that is never auto-sent and stays pending', async () => {
    const ws = await seedWorkspace();
    await seedApprovedKnowledge(ws.workspaceId, 'en', 'The price is 100000 sum.');

    // First message creates the conversation (always starts in 'auto').
    await postTelegram(ws.identifier, ws.secret, telegramUpdate(1, 5101, 'Hello, how much does it cost?'));
    await drainInbound();
    await drainOutbound();

    // Flip this conversation to approval mode (as an operator would), then
    // send a second inbound message that must produce a draft, not a send.
    await query(`UPDATE conversations SET mode = 'approval' WHERE workspace_id = $1`, [ws.workspaceId]);
    sendSpy.mockClear();

    await postTelegram(ws.identifier, ws.secret, telegramUpdate(2, 5101, 'Is it still available?'));
    await drainInbound();
    await drainOutbound();

    const draft = await query(
      `SELECT delivery_status FROM messages
       WHERE conversation_id = (SELECT id FROM conversations WHERE workspace_id = $1) AND sender = 'ai'
       ORDER BY created_at DESC LIMIT 1`,
      [ws.workspaceId]
    );
    expect(draft.rows[0].delivery_status).toBe('pending_approval');

    // No new job/send for the approval-mode message.
    const jobs = await query(`SELECT status FROM outbound_jobs WHERE workspace_id = $1`, [ws.workspaceId]);
    expect(jobs.rows).toHaveLength(1); // only the first (auto) message's job
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('scenario 3: human handoff — escalation routes to human mode, no AI auto-reply generated/sent', async () => {
    const ws = await seedWorkspace();

    await postTelegram(ws.identifier, ws.secret, telegramUpdate(1, 5201, 'I want to talk to a human operator'));
    await drainInbound();
    await drainOutbound();

    const conv = await query(`SELECT mode, status FROM conversations WHERE workspace_id = $1`, [ws.workspaceId]);
    expect(conv.rows[0].mode).toBe('human');
    expect(conv.rows[0].status).toBe('human_attention_required');

    // No AI-generated reply is ever persisted for an escalated message —
    // the handoff notice is dispatched directly to the provider, not
    // stored as a message/outbound_job (see ai-intelligence.ts's
    // escalation branch).
    const aiMessages = await query(
      `SELECT id FROM messages WHERE conversation_id = (SELECT id FROM conversations WHERE workspace_id = $1) AND sender = 'ai'`,
      [ws.workspaceId]
    );
    expect(aiMessages.rows).toHaveLength(0);
    const jobs = await query(`SELECT id FROM outbound_jobs WHERE workspace_id = $1`, [ws.workspaceId]);
    expect(jobs.rows).toHaveLength(0);
  });

  it('scenario 4: duplicate inbound event (provider retry) dedups to one processing pass', async () => {
    const ws = await seedWorkspace();
    await seedApprovedKnowledge(ws.workspaceId, 'en', 'The price is 100000 sum.');

    const payload = telegramUpdate(1, 5301, 'Hello, how much does it cost?');
    const res1 = await postTelegram(ws.identifier, ws.secret, payload);
    const res2 = await postTelegram(ws.identifier, ws.secret, payload); // simulated provider redelivery
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    await drainInbound();
    await drainOutbound();

    const events = await query(`SELECT id FROM provider_events WHERE workspace_id = $1`, [ws.workspaceId]);
    expect(events.rows).toHaveLength(1);

    const customerMsgs = await query(
      `SELECT id FROM messages WHERE conversation_id = (SELECT id FROM conversations WHERE workspace_id = $1) AND sender = 'customer'`,
      [ws.workspaceId]
    );
    expect(customerMsgs.rows).toHaveLength(1);

    const jobs = await query(`SELECT id FROM outbound_jobs WHERE workspace_id = $1`, [ws.workspaceId]);
    expect(jobs.rows).toHaveLength(1);
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it('scenario 5: transient provider failure — first attempt fails retryable, explicit recovery drives a real second provider call that succeeds', async () => {
    // NOTE on this codebase's actual retry semantics (verified against
    // src/lib/workers/processors/outbound.ts and migration 015): once a
    // job's `dispatched_at` marker is set (immediately before ANY provider
    // call), the worker will NOT call the provider again on a later claim
    // of that same job — even after a confirmed, non-ambiguous
    // `retryable_failed` outcome — it goes straight to `ambiguous`
    // instead ("Reclaimed job had an unconfirmed prior dispatch attempt").
    // `markRetryableFailed` deliberately does not clear `dispatched_at`;
    // only the explicit `resolveAmbiguousJob('confirmed_not_delivered', ...)`
    // primitive does (see outbound-jobs.ts). So a fully-automatic
    // "fail once, worker retries on its own, succeeds" loop does not
    // exist in the merged code today — this test instead exercises the
    // real, full recovery path the system actually provides: automatic
    // first attempt -> ambiguous on reclaim -> explicit operator
    // resolution -> a genuine second provider call -> sent. This is not a
    // guardrail/business-logic change (out of scope per the issue) — it is
    // this test asserting the system's actual current behavior rather
    // than an assumed one.
    const ws = await seedWorkspace();
    await seedApprovedKnowledge(ws.workspaceId, 'en', 'The price is 100000 sum.');

    sendSpy.mockReset();
    sendSpy
      .mockRejectedValueOnce(new ProviderDeliveryError('Simulated transient failure', { retryable: true, retryAfterMs: 500 }))
      .mockResolvedValueOnce({ providerMessageId: `tg-${randomUUID()}`, raw: {} });

    await postTelegram(ws.identifier, ws.secret, telegramUpdate(1, 5401, 'Hello, how much does it cost?'));
    await drainInbound();

    // First outbound attempt: fails retryable, job goes to retryable_failed
    // and the queue message is re-enqueued with a delay by runtime.ts.
    await drainOutbound();
    const afterFirstAttempt = await query(`SELECT status, attempts FROM outbound_jobs WHERE workspace_id = $1`, [ws.workspaceId]);
    expect(afterFirstAttempt.rows[0].status).toBe('retryable_failed');
    expect(afterFirstAttempt.rows[0].attempts).toBe(1);
    expect(sendSpy).toHaveBeenCalledTimes(1);

    // Wait out the real backoff delay (>=1s, since runtime.ts re-enqueues
    // with ceil(delayMs/1000) whole seconds) and let the worker reclaim it
    // for real: per the note above, this real reclaim goes to `ambiguous`
    // (never re-calling the provider) rather than retrying automatically.
    await sleep(1500);
    await drainOutbound();

    const jobId = (await query(`SELECT id, status FROM outbound_jobs WHERE workspace_id = $1`, [ws.workspaceId])).rows[0];
    expect(jobId.status).toBe('ambiguous');
    expect(sendSpy).toHaveBeenCalledTimes(1); // no second provider call happened automatically

    // Explicit recovery (an operator/reconciliation decision, per
    // resolveAmbiguousJob's own doc comment) confirms non-delivery and
    // reschedules the DB row — it deliberately does not itself emit a new
    // queue wake-up message (see outbound-jobs.ts / the resolve route),
    // so — mirroring what any real caller of this recovery primitive must
    // also do to get the worker to actually look at it again — this test
    // enqueues one directly via the same `enqueueOutboundJob` the rest of
    // the pipeline uses, then lets the real worker claim and process it.
    await resolveAmbiguousJob(jobId.id, 'confirmed_not_delivered');
    await enqueueOutboundJob({ query }, jobId.id);
    await drainOutbound();

    const finalJob = await query(`SELECT status, attempts FROM outbound_jobs WHERE workspace_id = $1`, [ws.workspaceId]);
    expect(finalJob.rows[0].status).toBe('sent');
    expect(sendSpy).toHaveBeenCalledTimes(2); // the second, real provider call after resolution
  }, 15_000);

  it('scenario 6: permanent provider failure ends in permanent_failed with no infinite retry', async () => {
    const ws = await seedWorkspace();
    await seedApprovedKnowledge(ws.workspaceId, 'en', 'The price is 100000 sum.');

    sendSpy.mockReset();
    sendSpy.mockRejectedValue(new ProviderDeliveryError('Invalid credential', { retryable: false }));

    await postTelegram(ws.identifier, ws.secret, telegramUpdate(1, 5501, 'Hello, how much does it cost?'));
    await drainInbound();
    await drainOutbound();

    const job = await query(`SELECT status, attempts FROM outbound_jobs WHERE workspace_id = $1`, [ws.workspaceId]);
    expect(job.rows[0].status).toBe('permanent_failed');
    expect(sendSpy).toHaveBeenCalledTimes(1);

    // Confirm no infinite retry loop: draining again does nothing further.
    await drainOutbound();
    const stillOne = await query(`SELECT status FROM outbound_jobs WHERE workspace_id = $1`, [ws.workspaceId]);
    expect(stillOne.rows).toHaveLength(1);
    expect(stillOne.rows[0].status).toBe('permanent_failed');
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it('scenario 7: tenant isolation — workspace A traffic never produces workspace B data', async () => {
    const wsA = await seedWorkspace();
    const wsB = await seedWorkspace();
    await seedApprovedKnowledge(wsA.workspaceId, 'en', 'A-answer.');
    await seedApprovedKnowledge(wsB.workspaceId, 'en', 'B-answer.');

    await postTelegram(wsA.identifier, wsA.secret, telegramUpdate(1, 5601, 'Hello, how much does it cost?'));
    await drainInbound();
    await drainOutbound();

    const customersA = await query(`SELECT id FROM customers WHERE workspace_id = $1`, [wsA.workspaceId]);
    const customersB = await query(`SELECT id FROM customers WHERE workspace_id = $1`, [wsB.workspaceId]);
    expect(customersA.rows).toHaveLength(1);
    expect(customersB.rows).toHaveLength(0);

    const conversationsB = await query(`SELECT id FROM conversations WHERE workspace_id = $1`, [wsB.workspaceId]);
    expect(conversationsB.rows).toHaveLength(0);

    const messagesB = await query(
      `SELECT m.id FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.workspace_id = $1`,
      [wsB.workspaceId]
    );
    expect(messagesB.rows).toHaveLength(0);

    const jobsB = await query(`SELECT id FROM outbound_jobs WHERE workspace_id = $1`, [wsB.workspaceId]);
    expect(jobsB.rows).toHaveLength(0);

    const jobsA = await query(`SELECT id FROM outbound_jobs WHERE workspace_id = $1`, [wsA.workspaceId]);
    expect(jobsA.rows).toHaveLength(1);

    // And the AI reply actually used workspace A's own knowledge base, not B's.
    const aiMsgA = await query(
      `SELECT content FROM messages WHERE conversation_id = (SELECT id FROM conversations WHERE workspace_id = $1) AND sender = 'ai'`,
      [wsA.workspaceId]
    );
    expect(aiMsgA.rows[0].content).toContain('A-answer.');
  });
});
