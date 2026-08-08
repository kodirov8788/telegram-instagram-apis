import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withLiveAuthorization } from '@/lib/auth/session';
import { errorResponse, HttpError, parseBody, parseValue, uuid } from '@/lib/http/validation';
import { AuditLogService } from '@/lib/services/audit-log';
import { createJob, enqueueOutboundJob, DuplicateActiveJobError } from '@/lib/services/outbound-jobs';

const statusFilter = z.enum(['pending_approval', 'suggested']);

const sendBody = z.object({
  conversationId: uuid,
  content: z.string().trim().min(1).max(4000),
});

// Minimum surface needed for ISSUE-11 to be functional: a way to discover
// pending drafts/suggestions for a conversation. Not an inbox UI — see PR
// description for why inbox/page.tsx is intentionally untouched.
export async function GET(req: NextRequest) {
  try {
    const conversationId = parseValue(req.nextUrl.searchParams.get('conversationId'), uuid);
    const statusParam = req.nextUrl.searchParams.get('status');
    const status = statusParam ? parseValue(statusParam, statusFilter) : undefined;

    const res = await withLiveAuthorization(req, 'conversation:read', (p, client) => {
      const params: unknown[] = [p.workspaceId, conversationId];
      let sql = `SELECT m.* FROM messages m JOIN conversations c ON c.id = m.conversation_id
        WHERE c.workspace_id = $1 AND m.conversation_id = $2`;
      if (status) { sql += ` AND m.delivery_status = $3`; params.push(status); }
      else { sql += ` AND m.delivery_status IN ('pending_approval', 'suggested')`; }
      return client.query(`${sql} ORDER BY m.created_at DESC`, params);
    });

    return NextResponse.json({ messages: res.rows });
  } catch (error) {
    return errorResponse(error);
  }
}

// A human operator's reply once a conversation has been taken over
// (mode = 'human'). Closes the gap identified alongside #46: previously
// there was no way for a human to actually respond via any interface.
//
// Deliberately mirrors the approve route's transaction shape (see that
// file's module comment for the full rationale): the message insert, the
// outbound_jobs row, and the pgmq enqueue happen inside ONE
// tenantTransaction, so a crash between them can never leave a message
// persisted with no job to ever deliver it. The provider call itself still
// only ever happens later, inside the outbound worker.
//
// connection_id / channel / recipient_id are always derived server-side
// from the conversation + customer rows — never taken from the request
// body — matching the trust-anchor discipline every other write path in
// this codebase follows.
//
// Duplicate-request protection (e.g. a double-click submitting the same
// reply twice in rapid succession): rather than adding a new idempotency-key
// column/migration for what the issue calls a boundable problem, this
// re-uses columns that already exist. Immediately before inserting, we look
// for a message this same operator already sent into this same conversation
// with identical content in the last 10 seconds and still 'pending' or
// 'sent'. If found, we treat the new request as the same logical send and
// return the existing message/job instead of creating a second one. A
// determined double-submit of genuinely-identical content within the same
// short window is exactly the "double-click" case this is meant to guard;
// deliberate rapid identical messages are rare enough in a human-operator
// reply flow that this tradeoff is acceptable without new schema.
export async function POST(req: NextRequest) {
  try {
    const body = await parseBody(req, sendBody);

    const result = await withLiveAuthorization(req, 'conversation:update', async (p, client) => {
      const convo = await client.query(
        `SELECT c.id AS conversation_id, c.workspace_id, c.channel, c.connection_id, c.mode,
                cust.telegram_id, cust.instagram_id, cc.is_active AS connection_active
         FROM conversations c
         JOIN customers cust ON cust.id = c.customer_id
         LEFT JOIN channel_connections cc ON cc.id = c.connection_id
         WHERE c.id = $1 AND c.workspace_id = $2`,
        [body.conversationId, p.workspaceId]
      );

      const convoRow = convo.rows[0];
      if (!convoRow) throw new HttpError(404, 'Conversation not found');
      if (convoRow.mode !== 'human') {
        throw new HttpError(409, 'Conversation is not in human mode; take over the conversation before replying');
      }
      if (!convoRow.connection_id || convoRow.connection_active !== true) {
        throw new HttpError(409, 'Channel connection for this conversation is not active');
      }

      const channelUserIdentifier = convoRow.channel === 'telegram' ? convoRow.telegram_id : convoRow.instagram_id;
      if (!channelUserIdentifier) {
        throw new HttpError(409, 'Customer has no channel identifier for this conversation');
      }

      // Duplicate-request guard — see module comment above.
      const existing = await client.query(
        `SELECT m.id, m.conversation_id
         FROM messages m
         WHERE m.conversation_id = $1
           AND m.sender = 'human_operator'
           AND m.sender_user_id = $2
           AND m.content = $3
           AND m.delivery_status IN ('pending', 'sent')
           AND m.created_at > NOW() - INTERVAL '10 seconds'
         ORDER BY m.created_at DESC
         LIMIT 1`,
        [convoRow.conversation_id, p.userId, body.content]
      );
      if (existing.rows[0]) {
        return { id: existing.rows[0].id, conversationId: existing.rows[0].conversation_id, deduplicated: true };
      }

      const inserted = await client.query(
        `INSERT INTO messages (conversation_id, workspace_id, sender, sender_user_id, content, delivery_status)
         VALUES ($1, $2, 'human_operator', $3, $4, 'pending')
         RETURNING id, conversation_id`,
        [convoRow.conversation_id, p.workspaceId, p.userId, body.content]
      );
      const message = inserted.rows[0];

      await client.query('SAVEPOINT job_creation');
      try {
        const job = await createJob(
          {
            workspaceId: convoRow.workspace_id,
            connectionId: convoRow.connection_id,
            channel: convoRow.channel,
            messageId: message.id,
            recipientId: String(channelUserIdentifier),
            content: body.content,
          },
          client
        );
        await enqueueOutboundJob(client, job.id);
      } catch (error) {
        if (error instanceof DuplicateActiveJobError) {
          await client.query('ROLLBACK TO SAVEPOINT job_creation');
        } else {
          throw error;
        }
      }

      await AuditLogService.logEvent({
        workspaceId: p.workspaceId,
        actorType: 'user',
        actorId: p.userId,
        action: 'message.sent_by_operator',
        entityType: 'message',
        entityId: message.id,
        newValue: { conversationId: message.conversation_id, deliveryStatus: 'pending' },
      });

      return { id: message.id, conversationId: message.conversation_id, deduplicated: false };
    });

    return NextResponse.json(
      { message: { id: result.id, conversationId: result.conversationId, deliveryStatus: 'pending', deduplicated: result.deduplicated } },
      { status: result.deduplicated ? 200 : 201 }
    );
  } catch (error) {
    return errorResponse(error);
  }
}
