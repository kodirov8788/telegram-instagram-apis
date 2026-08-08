import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withLiveAuthorization } from '@/lib/auth/session';
import { errorResponse, parseValue } from '@/lib/http/validation';

const statusEnum = z.enum(['received', 'queued', 'processing', 'processed', 'retryable_failed', 'permanent_failed']);
const statusListParam = z
  .string()
  .transform(v => v.split(',').map(s => s.trim()).filter(Boolean))
  .pipe(z.array(statusEnum).min(1));

// Dead-letter / failure-visibility surface for provider_events (issue #48)
// — mirrors GET /api/outbound-jobs. Defaults to permanent_failed (the
// inbound side's only terminal give-up state; there's no 'ambiguous'
// concept here). Never returns `payload` — that's raw provider webhook
// content and out of scope for an operational-visibility endpoint.
export async function GET(req: NextRequest) {
  try {
    const statusParam = req.nextUrl.searchParams.get('status');
    const statuses = statusParam
      ? parseValue(statusParam, statusListParam)
      : (['permanent_failed'] as const);

    const res = await withLiveAuthorization(req, 'conversation:read', (p, client) =>
      client.query(
        `SELECT id, workspace_id, connection_id, provider, provider_event_id, status, attempts,
                processed_at, last_error, created_at, updated_at
         FROM provider_events
         WHERE workspace_id = $1 AND status = ANY($2::text[])
         ORDER BY updated_at DESC
         LIMIT 200`,
        [p.workspaceId, statuses]
      )
    );

    return NextResponse.json({ events: res.rows });
  } catch (error) {
    return errorResponse(error);
  }
}
