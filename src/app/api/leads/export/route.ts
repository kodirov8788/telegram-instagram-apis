import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';

export async function GET(req: NextRequest) {
  try {
    const workspaceId = req.nextUrl.searchParams.get('workspace_id') || 'default-workspace';

    const res = await query(
      `SELECT l.id, cust.full_name, cust.phone_number, cust.email, cust.telegram_username, cust.instagram_username, 
              l.requested_product_or_service, l.budget, l.timeline, l.status, l.score, l.created_at
       FROM leads l
       JOIN customers cust ON l.customer_id = cust.id
       WHERE l.workspace_id = $1
       ORDER BY l.created_at DESC`,
      [workspaceId]
    );

    // Format CSV
    const headers = ['Lead ID', 'Full Name', 'Phone', 'Email', 'Telegram', 'Instagram', 'Product/Service', 'Budget', 'Timeline', 'Status', 'Score', 'Created At'];
    const rows = res.rows.map(r => [
      r.id,
      `"${r.full_name || ''}"`,
      `"${r.phone_number || ''}"`,
      `"${r.email || ''}"`,
      `"${r.telegram_username || ''}"`,
      `"${r.instagram_username || ''}"`,
      `"${r.requested_product_or_service || ''}"`,
      `"${r.budget || ''}"`,
      `"${r.timeline || ''}"`,
      r.status,
      r.score,
      r.created_at
    ]);

    const csvContent = [headers.join(','), ...rows.map(e => e.join(','))].join('\n');

    return new Response(csvContent, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': 'attachment; filename=leads_export.csv',
      },
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
