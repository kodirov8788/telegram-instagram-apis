import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withLiveAuthorization } from '@/lib/auth/session';
import { errorResponse, parseValue } from '@/lib/http/validation';

const statusEnum = z.enum(['pending', 'processing', 'sent', 'retryable_failed', 'permanent_failed', 'ambiguous']);
const statusListParam = z
  .string()
  .transform(v => v.split(',').map(s => s.trim()).filter(Boolean))
  .pipe(z.array(statusEnum).min(1));

// Dead-letter / failure-visibility surface for outbound_jobs (issue #48).
// Defaults to the two "needs a human" terminal states — permanent_failed
// (won't retry) and ambiguous (provider outcome unknown, see
// resolveAmbiguousJob) — but accepts a comma-separated `status` filter for
// any subset of the job state machine. Reuses 'conversation:read', same
// permission as GET /api/messages and the existing outbound-jobs resolve
// route's 'conversation:update' sibling.
export async function GET(req: NextRequest) {
  try {
    const statusParam = req.nextUrl.searchParams.get('status');
    const statuses = statusParam
      ? parseValue(statusParam, statusListParam)
      : (['permanent_failed', 'ambiguous'] as const);

    const res = await withLiveAuthorization(req, 'conversation:read', (p, client) =>
      client.query(
        `SELECT id, workspace_id, connection_id, channel, message_id, recipient_id, status, attempts,
                provider_message_id, last_error, next_attempt_at, sent_at, dispatched_at, created_at, updated_at
         FROM outbound_jobs
         WHERE workspace_id = $1 AND status = ANY($2::text[])
         ORDER BY updated_at DESC
         LIMIT 200`,
        [p.workspaceId, statuses]
      )
    );

    return NextResponse.json({ jobs: res.rows });
  } catch (error) {
    return errorResponse(error);
  }
}
