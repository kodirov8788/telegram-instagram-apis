import { NextRequest, NextResponse } from 'next/server';
import { withLiveAuthorization } from '@/lib/auth/session';
import { errorResponse } from '@/lib/http/validation';

/**
 * Worker "health" endpoint (issue #48) — bounded interpretation, see PR
 * description: the workers are separate Node processes, not HTTP servers,
 * so a real process-to-process healthcheck isn't available in this repo.
 * What's actually useful and DB-observable is "is the queue backing up":
 * the oldest still-unclaimed item's age per queue, for the caller's
 * workspace.
 *
 *  - inbound: oldest `provider_events` row in ('received', 'queued') —
 *    i.e. accepted but not yet picked up by a worker.
 *  - outbound: oldest `outbound_jobs` row in 'pending' whose
 *    `next_attempt_at` has already passed — i.e. due but not yet claimed.
 *
 * pgmq's own tables aren't queried directly: migration 010 revokes all
 * access to the `pgmq` schema from the runtime role, exposing only the
 * `ydeck_queue.*` wrapper functions (send/read/delete/archive) — none of
 * which answer "what's the oldest visible message" without also claiming
 * it. The application tables already carry the same "is it waiting"
 * information without that side effect, so this endpoint reads those
 * instead of granting new pgmq access.
 */
export async function GET(req: NextRequest) {
  try {
    const result = await withLiveAuthorization(req, 'conversation:read', async (p, client) => {
      const [inboundRes, outboundRes] = await Promise.all([
        client.query(
          `SELECT COUNT(*)::int AS backlog, MIN(created_at) AS oldest
           FROM provider_events WHERE workspace_id = $1 AND status IN ('received', 'queued')`,
          [p.workspaceId]
        ),
        client.query(
          `SELECT COUNT(*)::int AS backlog, MIN(next_attempt_at) AS oldest
           FROM outbound_jobs WHERE workspace_id = $1 AND status = 'pending' AND next_attempt_at <= NOW()`,
          [p.workspaceId]
        ),
      ]);

      const now = Date.now();
      const toAgeMs = (oldest: Date | string | null) => (oldest ? now - new Date(oldest).getTime() : null);

      const inbound = inboundRes.rows[0];
      const outbound = outboundRes.rows[0];

      return {
        inbound: { queue: 'inbound_events', backlogCount: inbound.backlog, oldestUnclaimedAgeMs: toAgeMs(inbound.oldest) },
        outbound: { queue: 'outbound_jobs', backlogCount: outbound.backlog, oldestUnclaimedAgeMs: toAgeMs(outbound.oldest) },
      };
    });

    return NextResponse.json({ status: 'ok', ...result });
  } catch (error) {
    return errorResponse(error);
  }
}
