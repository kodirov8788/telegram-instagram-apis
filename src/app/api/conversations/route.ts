import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withLiveAuthorization } from '@/lib/auth/session';
import { errorResponse, parseBody, parseValue, uuid } from '@/lib/http/validation';
import { AuditLogService } from '@/lib/services/audit-log';

const statuses = z.enum(['new','ai_handling','waiting_for_customer','human_attention_required','human_handling','qualified_lead','resolved','closed','spam']);
const modes = z.enum(['auto','approval','suggestion','human']);
const patchSchema = z.object({ conversationId: uuid, status: statuses.optional(), mode: modes.optional() }).strict().refine(v => v.status || v.mode);

export async function GET(req: NextRequest) {
  try {
    const status = req.nextUrl.searchParams.get('status');
    const parsedStatus = status ? parseValue(status, statuses) : undefined;
    const res = await withLiveAuthorization(req, 'conversation:read', (p, client) => {
      const params: unknown[] = [p.workspaceId];
      let sql = `SELECT c.*, cust.full_name, cust.telegram_username, cust.instagram_username,
      (SELECT content FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) last_message
      FROM conversations c JOIN customers cust ON c.customer_id = cust.id WHERE c.workspace_id = $1`;
      if (parsedStatus) { sql += ' AND c.status = $2'; params.push(parsedStatus); }
      return client.query(`${sql} ORDER BY c.last_message_at DESC`, params);
    });
    return NextResponse.json({ conversations: res.rows });
  } catch (error) { return errorResponse(error); }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await parseBody(req, patchSchema);
    const res = await withLiveAuthorization(req, 'conversation:update', async (p, client) => {
      const prev = body.mode
        ? (await client.query('SELECT mode FROM conversations WHERE id = $1 AND workspace_id = $2', [body.conversationId, p.workspaceId])).rows[0]
        : undefined;
      const updated = await client.query(`UPDATE conversations SET status = COALESCE($1, status), mode = COALESCE($2, mode), last_message_at = NOW()
      WHERE id = $3 AND workspace_id = $4 RETURNING *`, [body.status, body.mode, body.conversationId, p.workspaceId]);
      if (updated.rows[0] && body.mode && prev && prev.mode !== body.mode) {
        await AuditLogService.logEvent({
          workspaceId: p.workspaceId,
          actorType: 'user',
          actorId: p.userId,
          action: 'conversation.mode_changed',
          entityType: 'conversation',
          entityId: body.conversationId,
          previousValue: { mode: prev.mode },
          newValue: { mode: body.mode },
        });
      }
      return updated;
    });
    if (!res.rows[0]) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ conversation: res.rows[0] });
  } catch (error) { return errorResponse(error); }
}
