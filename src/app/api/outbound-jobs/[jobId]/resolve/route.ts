import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withLiveAuthorization } from '@/lib/auth/session';
import { errorResponse, HttpError, parseBody, parseValue, uuid } from '@/lib/http/validation';
import { resolveAmbiguousJob, InvalidJobTransitionError } from '@/lib/services/outbound-jobs';
import { AuditLogService } from '@/lib/services/audit-log';
import { query } from '@/lib/db';

const target = (ctx: { params: Promise<{ jobId: string }> }) => ctx.params.then(p => parseValue(p.jobId, uuid));
const schema = z
  .object({
    resolution: z.enum(['confirmed_delivered', 'confirmed_not_delivered', 'abandon']),
    providerMessageId: z.string().max(255).optional(),
  })
  .strict();

// Resolves an `ambiguous` outbound job — the only way one ever leaves that
// state (see resolveAmbiguousJob's doc comment). Deliberately manual/
// operator-invoked, not automatic: ambiguous means the provider's actual
// outcome is unknown, so only an explicit investigation (checking the
// provider's own delivery records, a support ticket, etc.) can resolve it
// safely. Reuses 'conversation:update' rather than a new permission, same
// pattern as the message approve/reject routes.
export async function POST(req: NextRequest, ctx: { params: Promise<{ jobId: string }> }) {
  try {
    const jobId = await target(ctx);
    const body = await parseBody(req, schema);

    const result = await withLiveAuthorization(req, 'conversation:update', async p => {
      // Tenant-scope the job before touching it — resolveAmbiguousJob itself
      // only guards on job id + current status, so the workspace check has
      // to happen here, same as every other tenant-scoped mutation route.
      const owned = await query(`SELECT id FROM outbound_jobs WHERE id = $1 AND workspace_id = $2`, [jobId, p.workspaceId]);
      if (!owned.rows[0]) throw new HttpError(404, 'Outbound job not found');

      let job;
      try {
        job = await resolveAmbiguousJob(jobId, body.resolution, body.providerMessageId);
      } catch (error) {
        if (error instanceof InvalidJobTransitionError) {
          throw new HttpError(409, `Job is not in an ambiguous state (or was resolved concurrently)`);
        }
        throw error;
      }

      await AuditLogService.logEvent({
        workspaceId: p.workspaceId,
        actorType: 'user',
        actorId: p.userId,
        action: `outbound_job.resolved_ambiguous.${body.resolution}`,
        entityType: 'outbound_job',
        entityId: job.id,
        newValue: { status: job.status },
      });

      return job;
    });

    return NextResponse.json({ job: result });
  } catch (error) {
    return errorResponse(error);
  }
}
