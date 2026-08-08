import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { identityTransaction } from '@/lib/db';
import { authenticate } from '@/lib/auth/session';
import { errorResponse, HttpError, parseBody } from '@/lib/http/validation';
import { AuditLogService } from '@/lib/services/audit-log';
const schema = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export async function POST(req: NextRequest) {
  try {
    const body = await parseBody(req, schema); const p = await authenticate(req);
    const invite = await identityTransaction(p.userId, client => client.query(
      'SELECT * FROM accept_workspace_invitation($1)',
      [createHash('sha256').update(body.token).digest('hex')],
    ));
    if (!invite.rows[0]) throw new HttpError(404, 'Invitation unavailable');
    await AuditLogService.logEvent({
      workspaceId: invite.rows[0].workspace_id,
      actorType: 'user',
      actorId: p.userId,
      action: 'invitation.accepted',
      entityType: 'workspace_invitation',
      entityId: invite.rows[0].workspace_id,
      newValue: { role: invite.rows[0].role },
    });
    return NextResponse.json({ workspaceId: invite.rows[0].workspace_id, role: invite.rows[0].role });
  } catch (error) { return errorResponse(error); }
}
