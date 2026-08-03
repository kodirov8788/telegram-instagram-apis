import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { tenantTransaction } from '@/lib/db';
import { authorize } from '@/lib/auth/session';
import { errorResponse, parseBody, parseValue, uuid } from '@/lib/http/validation';

const statuses = z.enum(['new','ai_handling','waiting_for_customer','human_attention_required','human_handling','qualified_lead','resolved','closed','spam']);
const modes = z.enum(['auto','approval','suggestion','human']);
const patchSchema = z.object({ conversationId: uuid, status: statuses.optional(), mode: modes.optional() }).strict().refine(v => v.status || v.mode);

export async function GET(req: NextRequest) {
  try {
    const p = await authorize(req, 'conversation:read');
    const status = req.nextUrl.searchParams.get('status');
    const parsedStatus = status ? parseValue(status, statuses) : undefined;
    const params: unknown[] = [p.workspaceId];
    let sql = `SELECT c.*, cust.full_name, cust.telegram_username, cust.instagram_username,
      (SELECT content FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) last_message
      FROM conversations c JOIN customers cust ON c.customer_id = cust.id WHERE c.workspace_id = $1`;
    if (parsedStatus) { sql += ' AND c.status = $2'; params.push(parsedStatus); }
    const res = await tenantTransaction(p.userId, client => client.query(`${sql} ORDER BY c.last_message_at DESC`, params));
    return NextResponse.json({ conversations: res.rows });
  } catch (error) { return errorResponse(error); }
}

export async function PATCH(req: NextRequest) {
  try {
    const p = await authorize(req, 'conversation:update');
    const body = await parseBody(req, patchSchema);
    const res = await tenantTransaction(p.userId, client => client.query(`UPDATE conversations SET status = COALESCE($1, status), mode = COALESCE($2, mode), last_message_at = NOW()
      WHERE id = $3 AND workspace_id = $4 RETURNING *`, [body.status, body.mode, body.conversationId, p.workspaceId]));
    if (!res.rows[0]) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ conversation: res.rows[0] });
  } catch (error) { return errorResponse(error); }
}
