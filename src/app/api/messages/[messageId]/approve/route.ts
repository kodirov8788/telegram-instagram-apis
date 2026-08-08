import { NextRequest, NextResponse } from 'next/server';
import { withLiveAuthorization } from '@/lib/auth/session';
import { errorResponse, HttpError, parseValue, uuid } from '@/lib/http/validation';
import { AuditLogService } from '@/lib/services/audit-log';
import { createJob, enqueueOutboundJob, DuplicateActiveJobError } from '@/lib/services/outbound-jobs';

const target = (ctx: { params: Promise<{ messageId: string }> }) => ctx.params.then(p => parseValue(p.messageId, uuid));

// Approves a `pending_approval` AI draft and sends it.
//
// Claim + job-creation + enqueue are ONE transaction (withLiveAuthorization's
// tenantTransaction) — closing the "approved but crashed before a job
// existed" stranded-message window. This is safe to do in one transaction
// specifically because none of it makes a network call: the claim UPDATE,
// the outbound_jobs INSERT, and the pgmq enqueue (itself a local table
// insert under the hood, see migration 010) are all local DB writes. The
// actual provider call happens later, inside the outbound worker, outside
// any transaction here — that's the boundary this route still respects.
//
// A SAVEPOINT wraps just the job-creation step: if `createJob` reports
// DuplicateActiveJobError (an active job already exists for this message —
// not expected in normal flow since the claim UPDATE only ever succeeds
// once per message, but defensive), we roll back to the savepoint and keep
// the already-committed 'approved' claim rather than losing it — the same
// graceful "someone else's job already exists, nothing more to do here"
// outcome this route had before, without discarding the approval itself.
export async function POST(req: NextRequest, ctx: { params: Promise<{ messageId: string }> }) {
  try {
    const messageId = await target(ctx);

    const claimed = await withLiveAuthorization(req, 'conversation:update', async (p, client) => {
      const claim = await client.query(
        `UPDATE messages m
         SET delivery_status = 'approved', reviewed_by = $2, reviewed_at = NOW()
         FROM conversations c, customers cust
         WHERE m.id = $1
           AND m.conversation_id = c.id
           AND c.customer_id = cust.id
           AND c.workspace_id = $3
           AND m.delivery_status = 'pending_approval'
           AND c.mode <> 'human'
         RETURNING m.id, m.content, c.id AS conversation_id, c.channel, c.connection_id, c.workspace_id,
           cust.telegram_id, cust.instagram_id`,
        [messageId, p.userId, p.workspaceId]
      );

      if (!claim.rows[0]) {
        // Distinguish "doesn't exist / wrong tenant" from "already resolved
        // or conversation moved to human" purely for a clearer error — the
        // atomicity guarantee above does not depend on this read.
        const probe = await client.query(
          `SELECT m.delivery_status, c.mode FROM messages m
           JOIN conversations c ON c.id = m.conversation_id
           WHERE m.id = $1 AND c.workspace_id = $2`,
          [messageId, p.workspaceId]
        );
        if (!probe.rows[0]) throw new HttpError(404, 'Message not found');
        if (probe.rows[0].mode === 'human') {
          throw new HttpError(409, 'Conversation is now in human mode; this draft can no longer be approved');
        }
        throw new HttpError(409, `Message is not pending approval (status: ${probe.rows[0].delivery_status})`);
      }

      const row = claim.rows[0];
      const channelUserIdentifier = row.channel === 'telegram' ? row.telegram_id : row.instagram_id;

      // Same transaction as the claim above (see the module-level comment
      // for why this is safe: no network call happens in this route). The
      // claim UPDATE already prevents concurrent double-approval
      // (delivery_status='pending_approval'->'approved' only ever succeeds
      // once); the SAVEPOINT here handles the defensive case where
      // createJob's DB-level unique-active-job constraint still fires,
      // without losing the approval that already committed in this same
      // transaction if it does.
      await client.query('SAVEPOINT job_creation');
      try {
        const job = await createJob(
          {
            workspaceId: row.workspace_id,
            connectionId: row.connection_id,
            channel: row.channel,
            messageId: row.id,
            recipientId: String(channelUserIdentifier),
            content: row.content,
          },
          client
        );
        await enqueueOutboundJob(client, job.id);
      } catch (error) {
        if (error instanceof DuplicateActiveJobError) {
          // Someone else's job already exists for this message; roll back
          // just the job-creation attempt, keep the approval.
          await client.query('ROLLBACK TO SAVEPOINT job_creation');
        } else {
          throw error;
        }
      }

      await AuditLogService.logEvent({
        workspaceId: p.workspaceId,
        actorType: 'user',
        actorId: p.userId,
        action: 'message.approved',
        entityType: 'message',
        entityId: row.id,
        newValue: { conversationId: row.conversation_id, deliveryStatus: 'approved' },
      });

      return row;
    });

    return NextResponse.json({ message: { id: claimed.id, conversationId: claimed.conversation_id, deliveryStatus: 'approved' } });
  } catch (error) {
    return errorResponse(error);
  }
}
