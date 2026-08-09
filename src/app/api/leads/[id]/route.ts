import { NextRequest, NextResponse } from 'next/server';
import { withLiveAuthorization } from '@/lib/auth/session';
import { errorResponse, HttpError, parseValue, uuid } from '@/lib/http/validation';

const target = (ctx: { params: Promise<{ id: string }> }) => ctx.params.then(p => parseValue(p.id, uuid));

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const id = await target(ctx);

    const lead = await withLiveAuthorization(req, 'leads:read', async (p, client) => {
      const res = await client.query(
        `SELECT l.id, l.workspace_id, l.customer_id, l.conversation_id, cust.full_name,
          cust.phone_number, cust.email, cust.telegram_username, cust.instagram_username,
          l.requested_product_or_service, l.budget, l.timeline, l.status, l.score,
          l.assigned_user_id, l.next_action, l.created_at, l.updated_at
          FROM leads l JOIN customers cust ON l.customer_id = cust.id
          WHERE l.id = $1 AND l.workspace_id = $2`,
        [id, p.workspaceId]
      );
      return res.rows[0] ?? null;
    });

    if (!lead) throw new HttpError(404, 'Lead not found');
    return NextResponse.json({ lead });
  } catch (error) { return errorResponse(error); }
}
