import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../../db', () => ({ query: mocks.query }));

import {
  createJob,
  claimNextJob,
  markSent,
  markRetryableFailed,
  markPermanentFailed,
  markAmbiguous,
  markDispatched,
  DuplicateActiveJobError,
  InvalidJobTransitionError,
} from '../outbound-jobs';

function makeUuid(n: number) {
  const hex = n.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
}

/**
 * Minimal in-memory model of the `outbound_jobs` table that honors the
 * same invariants as the real schema: the partial unique index on
 * message_id for active statuses, and conditional-UPDATE...WHERE status=
 * semantics for every transition. Lets these tests exercise real
 * concurrency/rejection behavior instead of a stubbed always-succeeds mock.
 */
function makeDb() {
  const rows = new Map<string, any>();
  let nextId = 1;
  const ACTIVE = new Set(['pending', 'processing', 'retryable_failed']);

  const query = vi.fn(async (text: string, params: unknown[] = []) => {
    if (text.startsWith('INSERT INTO outbound_jobs')) {
      const [workspaceId, connectionId, channel, messageId, recipientId, content] = params as string[];
      const hasActive = Array.from(rows.values()).some(r => r.message_id === messageId && ACTIVE.has(r.status));
      if (hasActive) {
        const err: any = new Error('duplicate key value violates unique constraint "outbound_jobs_message_active_unique"');
        err.code = '23505';
        throw err;
      }
      const id = makeUuid(nextId++);
      const row = {
        id,
        workspace_id: workspaceId,
        connection_id: connectionId,
        channel,
        message_id: messageId,
        recipient_id: recipientId,
        content,
        status: 'pending',
        attempts: 0,
        provider_message_id: null,
        last_error: null,
        next_attempt_at: new Date(0),
        sent_at: null,
        dispatched_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };
      rows.set(id, row);
      return { rows: [row] };
    }

    if (text.startsWith('UPDATE outbound_jobs') && text.includes("SELECT id FROM outbound_jobs")) {
      // claimNextJob: pick first claimable row deterministically (id order).
      const claimable = Array.from(rows.values())
        .filter(r => (r.status === 'pending' || r.status === 'retryable_failed') && r.next_attempt_at <= new Date())
        .sort((a, b) => (a.id < b.id ? -1 : 1))[0];
      if (!claimable) return { rows: [] };
      claimable.status = 'processing';
      claimable.attempts += 1;
      claimable.updated_at = new Date();
      return { rows: [claimable] };
    }

    if (text.startsWith('UPDATE outbound_jobs') && text.includes("status = 'sent'")) {
      const [id, providerMessageId] = params as string[];
      const row = rows.get(id);
      if (!row || row.status !== 'processing') return { rows: [] };
      row.status = 'sent';
      row.provider_message_id = providerMessageId;
      row.last_error = null;
      row.sent_at = new Date();
      return { rows: [row] };
    }

    if (text.startsWith('UPDATE outbound_jobs') && text.includes("status = 'retryable_failed'")) {
      const [id, err] = params as string[];
      const row = rows.get(id);
      if (!row || row.status !== 'processing') return { rows: [] };
      row.status = 'retryable_failed';
      row.last_error = err;
      return { rows: [row] };
    }

    if (text.startsWith('UPDATE outbound_jobs') && text.includes("status = 'permanent_failed'")) {
      const [id, err] = params as string[];
      const row = rows.get(id);
      if (!row || row.status !== 'processing') return { rows: [] };
      row.status = 'permanent_failed';
      row.last_error = err;
      return { rows: [row] };
    }

    if (text.startsWith('UPDATE outbound_jobs') && text.includes('dispatched_at = NOW()') && text.includes('dispatched_at IS NULL')) {
      const [id] = params as string[];
      const row = rows.get(id);
      if (!row || row.status !== 'processing' || row.dispatched_at !== null) return { rows: [] };
      row.dispatched_at = new Date();
      return { rows: [row] };
    }

    if (text.startsWith('UPDATE outbound_jobs') && text.includes("status = 'ambiguous'")) {
      const [id, err] = params as string[];
      const row = rows.get(id);
      if (!row || row.status !== 'processing') return { rows: [] };
      row.status = 'ambiguous';
      row.last_error = err;
      return { rows: [row] };
    }

    throw new Error(`Unhandled query in test db: ${text}`);
  });

  return { query, rows };
}

const jobInput = (overrides: Partial<Parameters<typeof createJob>[0]> = {}) => ({
  workspaceId: 'ws-1',
  connectionId: 'conn-1',
  channel: 'telegram' as const,
  messageId: 'msg-1',
  recipientId: 'cust-1',
  content: 'hello',
  ...overrides,
});

describe('outbound-jobs service', () => {
  beforeEach(() => {
    mocks.query.mockReset();
  });

  it('creates a pending job before any provider call', async () => {
    const db = makeDb();
    mocks.query.mockImplementation(db.query);

    const job = await createJob(jobInput());

    expect(job.status).toBe('pending');
    expect(job.messageId).toBe('msg-1');
    expect(job.providerMessageId).toBeNull();
    expect(job.attempts).toBe(0);
  });

  it('rejects a second active job for the same message', async () => {
    const db = makeDb();
    mocks.query.mockImplementation(db.query);

    await createJob(jobInput());

    await expect(createJob(jobInput())).rejects.toBeInstanceOf(DuplicateActiveJobError);
  });

  it('allows a new job for the same message once the prior one reached a terminal state', async () => {
    const db = makeDb();
    mocks.query.mockImplementation(db.query);

    const first = await createJob(jobInput());
    const claimed = await claimNextJob();
    expect(claimed?.id).toBe(first.id);
    await markSent(first.id, 'provider-msg-1');

    const second = await createJob(jobInput());
    expect(second.status).toBe('pending');
  });

  it('only one of two concurrent claims wins the same job', async () => {
    const db = makeDb();
    mocks.query.mockImplementation(db.query);
    await createJob(jobInput());

    const [a, b] = await Promise.all([claimNextJob(), claimNextJob()]);
    const winners = [a, b].filter(Boolean);

    expect(winners).toHaveLength(1);
    expect(winners[0]?.status).toBe('processing');
  });

  it('returns null when there is no claimable work', async () => {
    const db = makeDb();
    mocks.query.mockImplementation(db.query);

    const claimed = await claimNextJob();

    expect(claimed).toBeNull();
  });

  it('marks a claimed job sent and records the provider message id', async () => {
    const db = makeDb();
    mocks.query.mockImplementation(db.query);
    const job = await createJob(jobInput());
    await claimNextJob();

    const sent = await markSent(job.id, 'provider-msg-42');

    expect(sent.status).toBe('sent');
    expect(sent.providerMessageId).toBe('provider-msg-42');
    expect(sent.sentAt).toBeInstanceOf(Date);
  });

  it('rejects marking a non-processing job sent', async () => {
    const db = makeDb();
    mocks.query.mockImplementation(db.query);
    const job = await createJob(jobInput()); // still pending, never claimed

    await expect(markSent(job.id, 'provider-msg-1')).rejects.toBeInstanceOf(InvalidJobTransitionError);
  });

  it('rejects marking an already-sent job sent again', async () => {
    const db = makeDb();
    mocks.query.mockImplementation(db.query);
    const job = await createJob(jobInput());
    await claimNextJob();
    await markSent(job.id, 'provider-msg-1');

    await expect(markSent(job.id, 'provider-msg-1')).rejects.toBeInstanceOf(InvalidJobTransitionError);
  });

  it('marks a claimed job retryable_failed with a reason', async () => {
    const db = makeDb();
    mocks.query.mockImplementation(db.query);
    const job = await createJob(jobInput());
    await claimNextJob();

    const failed = await markRetryableFailed(job.id, 'timeout', 5_000);

    expect(failed.status).toBe('retryable_failed');
    expect(failed.lastError).toBe('timeout');
  });

  it('rejects marking a pending (unclaimed) job retryable_failed', async () => {
    const db = makeDb();
    mocks.query.mockImplementation(db.query);
    const job = await createJob(jobInput());

    await expect(markRetryableFailed(job.id, 'timeout', 5_000)).rejects.toBeInstanceOf(InvalidJobTransitionError);
  });

  it('marks a claimed job permanent_failed with a reason', async () => {
    const db = makeDb();
    mocks.query.mockImplementation(db.query);
    const job = await createJob(jobInput());
    await claimNextJob();

    const failed = await markPermanentFailed(job.id, 'invalid recipient');

    expect(failed.status).toBe('permanent_failed');
    expect(failed.lastError).toBe('invalid recipient');
  });

  it('rejects marking a pending (unclaimed) job permanent_failed', async () => {
    const db = makeDb();
    mocks.query.mockImplementation(db.query);
    const job = await createJob(jobInput());

    await expect(markPermanentFailed(job.id, 'nope')).rejects.toBeInstanceOf(InvalidJobTransitionError);
  });

  it('marks a claimed job ambiguous when the provider outcome is unknown', async () => {
    const db = makeDb();
    mocks.query.mockImplementation(db.query);
    const job = await createJob(jobInput());
    await claimNextJob();

    const ambiguous = await markAmbiguous(job.id, 'timed out after dispatch');

    expect(ambiguous.status).toBe('ambiguous');
  });

  describe('dispatched_at (ambiguous-delivery protection)', () => {
    it('markDispatched sets dispatched_at exactly once for a processing job', async () => {
      const db = makeDb();
      mocks.query.mockImplementation(db.query);
      const job = await createJob(jobInput());
      await claimNextJob();

      const first = await markDispatched(job.id);
      const second = await markDispatched(job.id);

      expect(first).toBe(true);
      expect(second).toBe(false); // already dispatched — never set twice
      expect(db.rows.get(job.id)?.dispatched_at).not.toBeNull();
    });

    it('markDispatched returns false for a job not currently processing', async () => {
      const db = makeDb();
      mocks.query.mockImplementation(db.query);
      const job = await createJob(jobInput()); // still pending, never claimed

      const result = await markDispatched(job.id);

      expect(result).toBe(false);
    });
  });
});
