import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import pool from '@/lib/db';
import { authenticate } from '@/lib/auth/session';
import { errorResponse, HttpError, parseBody } from '@/lib/http/validation';
const schema = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export async function POST(req: NextRequest) {
  let client;
  try {
    const body = await parseBody(req, schema); client = await pool.connect(); await client.query('BEGIN'); const p = await authenticate(req, client);
    const invite = (await client.query(`SELECT i.* FROM workspace_invitations i WHERE i.token_hash=$1 AND lower(i.email)=lower($2)
      AND i.accepted_at IS NULL AND i.expires_at>NOW() FOR UPDATE`, [createHash('sha256').update(body.token).digest('hex'), p.email])).rows[0];
    if (!invite) throw new HttpError(404, 'Invitation unavailable');
    const inserted = await client.query(`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,$3)
      ON CONFLICT(workspace_id,user_id) DO NOTHING RETURNING user_id`, [invite.workspace_id,p.userId,invite.role]);
    if (!inserted.rows[0]) throw new HttpError(404, 'Invitation unavailable');
    await client.query('UPDATE workspace_invitations SET accepted_at=NOW() WHERE id=$1', [invite.id]); await client.query('COMMIT');
    return NextResponse.json({ workspaceId: invite.workspace_id, role: invite.role });
  } catch (error) { if (client) await client.query('ROLLBACK'); return errorResponse(error); }
  finally { client?.release(); }
}
