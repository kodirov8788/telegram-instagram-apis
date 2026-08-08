import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withLiveAuthorization } from '@/lib/auth/session';
import { errorResponse, parseValue } from '@/lib/http/validation';

const statuses = z.enum([
  'unqualified', 'new_lead', 'interested', 'qualified',
  'high_priority', 'not_interested', 'customer', 'lost',
]);

export async function GET(req: NextRequest) {
  try {
    const status = req.nextUrl.searchParams.get('status');
    const parsedStatus = status ? parseValue(status, statuses) : undefined;
    const res = await withLiveAuthorization(req, 'leads:read', (p, client) => {
      const params: unknown[] = [p.workspaceId];
      let sql = `SELECT l.id, l.workspace_id, l.customer_id, l.conversation_id, cust.full_name,
        cust.phone_number, cust.email, cust.telegram_username, cust.instagram_username,
        l.requested_product_or_service, l.budget, l.timeline, l.status, l.score,
        l.assigned_user_id, l.next_action, l.created_at, l.updated_at
        FROM leads l JOIN customers cust ON l.customer_id = cust.id
        WHERE l.workspace_id = $1`;
      if (parsedStatus) { sql += ' AND l.status = $2'; params.push(parsedStatus); }
      return client.query(`${sql} ORDER BY l.score DESC, l.created_at DESC`, params);
    });
    return NextResponse.json({ leads: res.rows });
  } catch (error) { return errorResponse(error); }
}
