import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withLiveAuthorization } from '@/lib/auth/session';
import { errorResponse, HttpError, parseBody, parseValue, uuid } from '@/lib/http/validation';
import { AuditLogService } from '@/lib/services/audit-log';

const target = (ctx: { params: Promise<{ messageId: string }> }) => ctx.params.then(p => parseValue(p.messageId, uuid));
const schema = z.object({ reason: z.string().max(1000).optional() }).strict();

// Rejects a `pending_approval` AI draft. Same atomic single-UPDATE shape as
// approve — duplicate-rejection and approve-vs-reject races both resolve to
// "second caller matches 0 rows" rather than a corrupted double-transition.
export async function POST(req: NextRequest, ctx: { params: Promise<{ messageId: string }> }) {
  try {
    const messageId = await target(ctx);
    const body = await parseBody(req, schema);

    const result = await withLiveAuthorization(req, 'conversation:update', async (p, client) => {
      const claim = await client.query(
        `UPDATE messages m
         SET delivery_status = 'rejected', reviewed_by = $2, reviewed_at = NOW(), rejection_reason = $4
         FROM conversations c
         WHERE m.id = $1
           AND m.conversation_id = c.id
           AND c.workspace_id = $3
           AND m.delivery_status = 'pending_approval'
         RETURNING m.id, c.id AS conversation_id`,
        [messageId, p.userId, p.workspaceId, body.reason ?? null]
      );

      if (!claim.rows[0]) {
        const probe = await client.query(
          `SELECT m.delivery_status FROM messages m JOIN conversations c ON c.id = m.conversation_id
           WHERE m.id = $1 AND c.workspace_id = $2`,
          [messageId, p.workspaceId]
        );
        if (!probe.rows[0]) throw new HttpError(404, 'Message not found');
        throw new HttpError(409, `Message is not pending approval (status: ${probe.rows[0].delivery_status})`);
      }

      const row = claim.rows[0];
      await AuditLogService.logEvent({
        workspaceId: p.workspaceId,
        actorType: 'user',
        actorId: p.userId,
        action: 'message.rejected',
        entityType: 'message',
        entityId: row.id,
        newValue: { conversationId: row.conversation_id, deliveryStatus: 'rejected', reason: body.reason },
      });

      return { id: row.id, conversationId: row.conversation_id, deliveryStatus: 'rejected' };
    });

    return NextResponse.json({ message: result });
  } catch (error) {
    return errorResponse(error);
  }
}
