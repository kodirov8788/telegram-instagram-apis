import { NextRequest, NextResponse } from 'next/server';
import { withLiveAuthorization } from '@/lib/auth/session';
import { errorResponse, HttpError, parseValue, uuid } from '@/lib/http/validation';

const target = (ctx: { params: Promise<{ id: string }> }) => ctx.params.then(p => parseValue(p.id, uuid));

// Detail/thread endpoint: the conversation row plus its full message
// history, both scoped to the caller's workspace_id via the same
// tenant-checked pattern as GET /api/conversations (list).
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const id = await target(ctx);

    const result = await withLiveAuthorization(req, 'conversation:read', async (p, client) => {
      const convRes = await client.query(
        `SELECT c.*, cust.full_name, cust.phone_number, cust.email, cust.telegram_username, cust.instagram_username
         FROM conversations c JOIN customers cust ON c.customer_id = cust.id
         WHERE c.id = $1 AND c.workspace_id = $2`,
        [id, p.workspaceId]
      );
      const conversation = convRes.rows[0];
      if (!conversation) return null;

      const messagesRes = await client.query(
        `SELECT id, conversation_id, sender, sender_user_id, content, message_type, attachment_url,
                delivery_status, ai_confidence, created_at
         FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
        [id]
      );

      return { conversation, messages: messagesRes.rows };
    });

    if (!result) throw new HttpError(404, 'Conversation not found');
    return NextResponse.json(result);
  } catch (error) { return errorResponse(error); }
}
