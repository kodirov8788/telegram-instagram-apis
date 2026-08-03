import { NextRequest, NextResponse } from 'next/server';
import { cookieOptions, revokeSession, SESSION_COOKIE } from '@/lib/auth/session';
import { errorResponse } from '@/lib/http/validation';
export async function POST(req: NextRequest) {
  try {
    await revokeSession(req);
    const res = NextResponse.json({ ok: true });
    res.cookies.set(SESSION_COOKIE, '', { ...cookieOptions(), maxAge: 0 });
    return res;
  } catch (error) { return errorResponse(error); }
}
