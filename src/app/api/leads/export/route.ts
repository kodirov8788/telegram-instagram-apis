import { NextRequest } from 'next/server';
import { tenantTransaction } from '@/lib/db';
import { authorize } from '@/lib/auth/session';
import { errorResponse } from '@/lib/http/validation';

const csv = (value: unknown) => {
  let text = value == null ? '' : String(value);
  if (/^[\s\x00-\x1f]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
};
export async function GET(req: NextRequest) {
  try {
    const p = await authorize(req, 'leads:export');
    const res = await tenantTransaction(p.userId, client => client.query(`SELECT l.id, cust.full_name, cust.phone_number, cust.email, cust.telegram_username, cust.instagram_username,
      l.requested_product_or_service, l.budget, l.timeline, l.status, l.score, l.created_at
      FROM leads l JOIN customers cust ON l.customer_id = cust.id WHERE l.workspace_id = $1 ORDER BY l.created_at DESC`, [p.workspaceId]));
    const headers = ['Lead ID','Full Name','Phone','Email','Telegram','Instagram','Product/Service','Budget','Timeline','Status','Score','Created At'];
    const keys = ['id','full_name','phone_number','email','telegram_username','instagram_username','requested_product_or_service','budget','timeline','status','score','created_at'];
    const content = [headers.map(csv).join(','), ...res.rows.map(row => keys.map(key => csv(row[key])).join(','))].join('\r\n');
    return new Response(content, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="leads_export.csv"', 'X-Content-Type-Options': 'nosniff' } });
  } catch (error) { return errorResponse(error); }
}
