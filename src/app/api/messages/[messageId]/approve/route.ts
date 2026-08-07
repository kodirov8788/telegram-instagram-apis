import { NextRequest, NextResponse } from 'next/server';
import { withLiveAuthorization } from '@/lib/auth/session';
import { query } from '@/lib/db';
import { errorResponse, HttpError, parseValue, uuid } from '@/lib/http/validation';
import { AIIntelligenceService } from '@/lib/services/ai-intelligence';
import { AuditLogService } from '@/lib/services/audit-log';

const target = (ctx: { params: Promise<{ messageId: string }> }) => ctx.params.then(p => parseValue(p.messageId, uuid));

// Approves a `pending_approval` AI draft and sends it.
//
// Two phases, deliberately not one transaction:
//   1. Claim: a single atomic UPDATE, tenant-scoped, committed before we
//      return from withLiveAuthorization. This is simultaneously tenant
//      isolation, duplicate-approval protection (a second concurrent
//      approve/reject sees delivery_status already changed and matches 0
//      rows), and the "mode changed to human while pending" guard.
//   2. Dispatch: runs AFTER that commit, outside any transaction. Holding a
//      DB transaction open across the outbound network call would block
//      other work on this row for the duration of that call; worse, if the
//      transaction's COMMIT failed after the external send already
//      succeeded, a rollback would put the message back to
//      'pending_approval' and let someone approve (and send) it again. By
//      committing the approval as 'approved' first, dispatch failure just
//      means a follow-up UPDATE to 'failed' — the approval itself is never
//      undone or repeatable.
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

    const channelUserIdentifier = claimed.channel === 'telegram' ? claimed.telegram_id : claimed.instagram_id;

    try {
      await AIIntelligenceService.dispatchOutboundMessage(
        {
          workspaceId: claimed.workspace_id,
          channel: claimed.channel,
          channelUserIdentifier,
          content: claimed.content,
          messageType: 'text',
          rawPayload: null,
          connectionId: claimed.connection_id ?? undefined,
        },
        claimed.content
      );
      await query(`UPDATE messages SET delivery_status = 'sent' WHERE id = $1`, [claimed.id]);
    } catch (error) {
      await query(`UPDATE messages SET delivery_status = 'failed' WHERE id = $1`, [claimed.id]);
      throw error;
    }

    return NextResponse.json({ message: { id: claimed.id, conversationId: claimed.conversation_id, deliveryStatus: 'sent' } });
  } catch (error) {
    return errorResponse(error);
  }
}
