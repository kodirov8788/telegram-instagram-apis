import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withLiveAuthorization } from '@/lib/auth/session';
import { roles } from '@/lib/auth/permissions';
import { errorResponse, HttpError, parseBody, parseValue, uuid } from '@/lib/http/validation';
import { AuditLogService } from '@/lib/services/audit-log';
const assignable = roles.filter(r => r !== 'owner');
const schema = z.object({ role: z.enum(assignable as [typeof assignable[number], ...typeof assignable[number][]]) }).strict();
const target = (ctx: { params: Promise<{ userId: string }> }) => ctx.params.then(p => parseValue(p.userId, uuid));
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ userId: string }> }) {
  try {
    const userId = await target(ctx); const body = await parseBody(req, schema);
    const result = await withLiveAuthorization(req, 'members:update', async (p, client) => {
      if (userId === p.userId) throw new HttpError(400, 'Cannot change your own role');
      if (body.role === 'admin' && p.role !== 'owner') throw new HttpError(403, 'Only owners may assign administrators');
      const locked = await client.query('SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR UPDATE', [p.workspaceId, userId]);
      const targetRole = locked.rows[0]?.role;
      if (!targetRole || targetRole === 'owner' || (targetRole === 'admin' && p.role !== 'owner')) throw new HttpError(404, 'Member not found');
      const updated = await client.query('UPDATE workspace_members SET role=$1 WHERE workspace_id=$2 AND user_id=$3 RETURNING user_id,role', [body.role,p.workspaceId,userId]);
      if (updated.rows[0]) {
        await AuditLogService.logEvent({
          workspaceId: p.workspaceId,
          actorType: 'user',
          actorId: p.userId,
          action: 'member.role_changed',
          entityType: 'workspace_member',
          entityId: userId,
          previousValue: { role: targetRole },
          newValue: { role: body.role },
        });
      }
      return updated;
    });
    if (!result.rows[0]) throw new HttpError(404, 'Member not found'); return NextResponse.json({ member: result.rows[0] });
  } catch (error) { return errorResponse(error); }
}
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ userId: string }> }) {
  try {
    const userId = await target(ctx);
    const result = await withLiveAuthorization(req, 'members:remove', async (p, client) => {
      if (userId === p.userId) throw new HttpError(400, 'Cannot remove yourself');
      const locked = await client.query('SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR UPDATE', [p.workspaceId, userId]);
      const targetRole = locked.rows[0]?.role;
      if (!targetRole || targetRole === 'owner' || (targetRole === 'admin' && p.role !== 'owner')) throw new HttpError(404, 'Member not found');
      const deleted = await client.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 RETURNING user_id', [p.workspaceId,userId]);
      if (deleted.rows[0]) {
        await AuditLogService.logEvent({
          workspaceId: p.workspaceId,
          actorType: 'user',
          actorId: p.userId,
          action: 'member.removed',
          entityType: 'workspace_member',
          entityId: userId,
          previousValue: { role: targetRole },
        });
      }
      return deleted;
    });
    if (!result.rows[0]) throw new HttpError(404, 'Member not found'); return new Response(null, { status: 204 });
  } catch (error) { return errorResponse(error); }
}
