import { NextRequest, NextResponse } from 'next/server';
import { tenantTransaction } from '@/lib/db';
import { authorize } from '@/lib/auth/session';
import { errorResponse } from '@/lib/http/validation';
export async function GET(req: NextRequest) {
  try { const p = await authorize(req, 'members:read'); const result = await tenantTransaction(p.userId, client => client.query(`SELECT wm.user_id,u.email,u.full_name,wm.role,wm.created_at
    FROM workspace_members wm JOIN users u ON u.id=wm.user_id WHERE wm.workspace_id=$1 ORDER BY wm.created_at`, [p.workspaceId])); return NextResponse.json({ members: result.rows }); }
  catch (error) { return errorResponse(error); }
}
