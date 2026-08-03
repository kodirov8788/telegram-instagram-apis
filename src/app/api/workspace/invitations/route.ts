import { createHash, randomBytes } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withLiveAuthorization } from '@/lib/auth/session';
import { roles } from '@/lib/auth/permissions';
import { errorResponse, HttpError, parseBody } from '@/lib/http/validation';
const allowedInviteRoles = roles.filter(r => r !== 'owner');
const schema = z.object({ email: z.string().trim().toLowerCase().email().max(255), role: z.enum(allowedInviteRoles as [typeof allowedInviteRoles[number], ...typeof allowedInviteRoles[number][]]) }).strict();
export async function POST(req: NextRequest) {
  try {
    const body = await parseBody(req, schema);
    const token = randomBytes(32).toString('hex'); const tokenHash = createHash('sha256').update(token).digest('hex');
    const result = await withLiveAuthorization(req, 'members:invite', async (p, client) => {
      if (body.role === 'admin' && p.role !== 'owner') throw new HttpError(403, 'Only owners may invite administrators');
      await client.query(`UPDATE workspace_invitations SET accepted_at=NOW()
        WHERE workspace_id=$1 AND lower(email)=lower($2) AND accepted_at IS NULL AND expires_at<=NOW()`, [p.workspaceId, body.email]);
      return client.query(`INSERT INTO workspace_invitations (workspace_id,email,role,token_hash,invited_by,expires_at)
        SELECT $1,$2,$3,$4,$5,NOW() + INTERVAL '7 days' WHERE NOT EXISTS
        (SELECT 1 FROM workspace_members wm JOIN users u ON u.id=wm.user_id WHERE wm.workspace_id=$1 AND lower(u.email)=lower($2))
        RETURNING id,email,role,expires_at`, [p.workspaceId, body.email, body.role, tokenHash, p.userId]);
    });
    if (!result.rows[0]) throw new HttpError(409, 'Unable to create invitation');
    return NextResponse.json({ invitation: result.rows[0], token }, { status: 201 });
  } catch (error: unknown) { if ((error as { code?: string }).code === '23505') return NextResponse.json({ error: 'Unable to create invitation' }, { status: 409 }); return errorResponse(error); }
}
