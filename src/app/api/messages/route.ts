import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withLiveAuthorization } from '@/lib/auth/session';
import { errorResponse, parseValue, uuid } from '@/lib/http/validation';

const statusFilter = z.enum(['pending_approval', 'suggested']);

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
