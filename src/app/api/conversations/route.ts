import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';

export async function GET(req: NextRequest) {
  try {
    const workspaceId = req.nextUrl.searchParams.get('workspace_id') || 'default-workspace';
    const statusFilter = req.nextUrl.searchParams.get('status');

    let sql = `
      SELECT c.*, cust.full_name, cust.telegram_username, cust.instagram_username,
        (SELECT content FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message
      FROM conversations c
      JOIN customers cust ON c.customer_id = cust.id
      WHERE c.workspace_id = $1
    `;
    const params: any[] = [workspaceId];

    if (statusFilter) {
      sql += ` AND c.status = $2`;
      params.push(statusFilter);
    }

    sql += ` ORDER BY c.last_message_at DESC`;

    const res = await query(sql, params);
    return NextResponse.json({ conversations: res.rows });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    const { conversationId, status, mode } = body;

    const res = await query(
      `UPDATE conversations 
       SET status = COALESCE($1, status), mode = COALESCE($2, mode), last_message_at = NOW()
       WHERE id = $3 RETURNING *`,
      [status, mode, conversationId]
    );

    return NextResponse.json({ conversation: res.rows[0] });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
