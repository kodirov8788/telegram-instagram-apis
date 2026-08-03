import { NextRequest, NextResponse } from 'next/server';
import { compare } from 'bcryptjs';
import { z } from 'zod';
import { query } from '@/lib/db';
import { cookieOptions, createSession, SESSION_COOKIE } from '@/lib/auth/session';
import { errorResponse, HttpError, parseBody } from '@/lib/http/validation';
const schema = z.object({ email: z.string().trim().toLowerCase().email().max(255), password: z.string().min(8).max(128) }).strict();
export async function POST(req: NextRequest) {
  try {
    const body = await parseBody(req, schema);
    const result = await query('SELECT id, email, password_hash FROM users WHERE email = $1', [body.email]);
    const user = result.rows[0];
    if (!user?.password_hash || !(await compare(body.password, user.password_hash))) throw new HttpError(401, 'Invalid email or password');
    const session = await createSession(user.id);
    const res = NextResponse.json({ user: { id: user.id, email: user.email } });
    res.cookies.set(SESSION_COOKIE, session.token, cookieOptions(session.expiresAt));
    return res;
  } catch (error) { return errorResponse(error); }
}
