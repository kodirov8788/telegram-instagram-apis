import { NextRequest, NextResponse } from 'next/server';
import { hash } from 'bcryptjs';
import { z } from 'zod';
import pool from '@/lib/db';
import { cookieOptions, createSession, SESSION_COOKIE } from '@/lib/auth/session';
import { errorResponse, HttpError, parseBody } from '@/lib/http/validation';
const schema = z.object({ email: z.string().trim().toLowerCase().email().max(255), fullName: z.string().trim().min(1).max(255), password: z.string().min(12).max(128) }).strict();
export async function POST(req: NextRequest) {
  let client;
  try {
    const body = await parseBody(req, schema); client = await pool.connect(); await client.query('BEGIN');
    const passwordHash = await hash(body.password, 12);
    const result = await client.query('INSERT INTO users (email, full_name, password_hash) VALUES ($1,$2,$3) ON CONFLICT (email) DO NOTHING RETURNING id,email,full_name', [body.email, body.fullName, passwordHash]);
    if (!result.rows[0]) throw new HttpError(409, 'Account already exists');
    await client.query('COMMIT');
    const session = await createSession(result.rows[0].id);
    const res = NextResponse.json({ user: result.rows[0] }, { status: 201 }); res.cookies.set(SESSION_COOKIE, session.token, cookieOptions(session.expiresAt)); return res;
  } catch (error) { if (client) await client.query('ROLLBACK'); return errorResponse(error); }
  finally { client?.release(); }
}
