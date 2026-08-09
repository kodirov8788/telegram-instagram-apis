import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/db', () => ({
  query: vi.fn(),
  identityTransaction: vi.fn(async (_userId: string, operation: (client: { query: typeof query }) => unknown) => operation({ query })),
  tenantTransaction: vi.fn(async (_userId: string, operation: (client: { query: typeof query }) => unknown) => operation({ query })),
  default: { connect: vi.fn() },
}));
vi.mock('@/lib/services/audit-log', () => ({ AuditLogService: { logEvent: vi.fn() } }));
vi.mock('@/lib/supabase/server', async () => {
  const m = await import('@/lib/auth/__tests__/supabase-session-mock');
  return { createSupabaseServerClient: m.mockCreateSupabaseServerClient };
});

import { query } from '@/lib/db';
import { AuditLogService } from '@/lib/services/audit-log';
import { POST as resolve } from '../[jobId]/resolve/route';
import { setMockSupabaseUser } from '@/lib/auth/__tests__/supabase-session-mock';

const db = vi.mocked(query);
const audit = vi.mocked(AuditLogService.logEvent);

const wid = '11111111-1111-4111-8111-111111111111';
const jid = '22222222-2222-4222-8222-222222222222';
const headers = { 'x-workspace-id': wid, 'content-type': 'application/json' };
const ctx = { params: Promise.resolve({ jobId: jid }) };
const req = (body: object) => new NextRequest(`https://app.test/api/outbound-jobs/${jid}/resolve`, { method: 'POST', headers, body: JSON.stringify(body) });

const member = (role = 'support_operator') => db.mockResolvedValueOnce({ rows: [{ role }] } as never);
const owned = () => db.mockResolvedValueOnce({ rows: [{ id: jid }] } as never);

beforeEach(() => {
  db.mockReset();
  audit.mockReset();
  setMockSupabaseUser({ id: 'user-1', email: 'u@test.dev' });
});

describe('POST /api/outbound-jobs/:id/resolve', () => {
  it('resolves confirmed_delivered by marking the job sent, no re-dispatch implied', async () => {
    member();
    owned();
    db.mockResolvedValueOnce({ rows: [{ id: jid, status: 'sent' }] } as never); // resolveAmbiguousJob's UPDATE

    const res = await resolve(req({ resolution: 'confirmed_delivered' }), ctx);

    expect(res.status).toBe(200);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'outbound_job.resolved_ambiguous.confirmed_delivered', entityId: jid }));
  });

  it('resolves confirmed_not_delivered by scheduling a safe retry (dispatched_at cleared)', async () => {
    member();
    owned();
    db.mockResolvedValueOnce({ rows: [{ id: jid, status: 'retryable_failed' }] } as never);

    const res = await resolve(req({ resolution: 'confirmed_not_delivered' }), ctx);

    expect(res.status).toBe(200);
    const updateCall = db.mock.calls.find(c => typeof c[0] === 'string' && c[0].includes("status = 'retryable_failed'") && c[0].includes('ambiguous'));
    expect(updateCall).toBeTruthy();
    expect(updateCall![0]).toContain('dispatched_at = NULL');
  });

  it('rejects resolving a job that is not currently ambiguous', async () => {
    member();
    owned();
    db.mockResolvedValueOnce({ rows: [] } as never); // resolveAmbiguousJob's UPDATE matched nothing

    const res = await resolve(req({ resolution: 'abandon' }), ctx);

    expect(res.status).toBe(409);
  });

  it('returns 404 for a job outside the caller workspace', async () => {
    member();
    db.mockResolvedValueOnce({ rows: [] } as never); // tenant-ownership check finds nothing

    const res = await resolve(req({ resolution: 'abandon' }), ctx);

    expect(res.status).toBe(404);
  });
});
