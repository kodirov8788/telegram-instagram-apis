import { createHash, randomBytes } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query } from '@/lib/db';
import { authorize } from '@/lib/auth/session';
import { roles } from '@/lib/auth/permissions';
import { errorResponse, HttpError, parseBody } from '@/lib/http/validation';
const allowedInviteRoles = roles.filter(r => r !== 'owner');
const schema = z.object({ email: z.string().trim().toLowerCase().email().max(255), role: z.enum(allowedInviteRoles as [typeof allowedInviteRoles[number], ...typeof allowedInviteRoles[number][]]) }).strict();
export async function POST(req: NextRequest) {
  try {
    const p = await authorize(req, 'members:invite'); const body = await parseBody(req, schema);
    if (body.role === 'admin' && p.role !== 'owner') throw new HttpError(403, 'Only owners may invite administrators');
    const token = randomBytes(32).toString('hex'); const tokenHash = createHash('sha256').update(token).digest('hex');
    const result = await query(`INSERT INTO workspace_invitations (workspace_id,email,role,token_hash,invited_by,expires_at)
      VALUES ($1,$2,$3,$4,$5,NOW() + INTERVAL '7 days') RETURNING id,email,role,expires_at`, [p.workspaceId, body.email, body.role, tokenHash, p.userId]);
    return NextResponse.json({ invitation: result.rows[0], token }, { status: 201 });
  } catch (error) { return errorResponse(error); }
}
