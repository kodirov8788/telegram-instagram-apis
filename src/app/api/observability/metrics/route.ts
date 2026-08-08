import { NextRequest, NextResponse } from 'next/server';
import { withLiveAuthorization } from '@/lib/auth/session';
import { errorResponse } from '@/lib/http/validation';

const INBOUND_STATUSES = ['received', 'queued', 'processing', 'processed', 'retryable_failed', 'permanent_failed'] as const;
const OUTBOUND_STATUSES = ['pending', 'processing', 'sent', 'retryable_failed', 'permanent_failed', 'ambiguous'] as const;

function zeroFill<T extends readonly string[]>(statuses: T): Record<T[number], number> {
  return Object.fromEntries(statuses.map(s => [s, 0])) as Record<T[number], number>;
}

/**
 * Retry/failure metrics (issue #48) — a minimal counter-style summary of
 * current row counts per status, per queue-backed table, for the calling
 * workspace. Deliberately just a DB-query-backed JSON endpoint: no
 * external metrics system (Prometheus/StatsD) is integrated, per the
 * issue's explicit non-goal.
 *
 * Scoped to the caller's workspace via `withLiveAuthorization` /
 * 'conversation:read', same as the rest of this feature's endpoints —
 * `provider_events`/`outbound_jobs` carry no RLS policy of their own
 * (see migrations 009, 013), so every query here filters on
 * `workspace_id` explicitly.
 */
export async function GET(req: NextRequest) {
  try {
    const result = await withLiveAuthorization(req, 'conversation:read', async (p, client) => {
      const [inboundRes, outboundRes] = await Promise.all([
        client.query(`SELECT status, COUNT(*)::int AS count FROM provider_events WHERE workspace_id = $1 GROUP BY status`, [p.workspaceId]),
        client.query(`SELECT status, COUNT(*)::int AS count FROM outbound_jobs WHERE workspace_id = $1 GROUP BY status`, [p.workspaceId]),
      ]);

      const inbound = zeroFill(INBOUND_STATUSES);
      for (const row of inboundRes.rows) if (row.status in inbound) inbound[row.status as (typeof INBOUND_STATUSES)[number]] = row.count;

      const outbound = zeroFill(OUTBOUND_STATUSES);
      for (const row of outboundRes.rows) if (row.status in outbound) outbound[row.status as (typeof OUTBOUND_STATUSES)[number]] = row.count;

      return { inbound, outbound };
    });

    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
