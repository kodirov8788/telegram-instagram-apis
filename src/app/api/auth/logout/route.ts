import { NextRequest, NextResponse } from 'next/server';
import { authenticate, cookieOptions, revokeSession, SESSION_COOKIE } from '@/lib/auth/session';
import { errorResponse } from '@/lib/http/validation';
import { AuditLogService } from '@/lib/services/audit-log';
export async function POST(req: NextRequest) {
  try {
    const principal = await authenticate(req).catch(() => null);
    await revokeSession(req);
    if (principal) {
      await AuditLogService.logEvent({ actorType: 'user', actorId: principal.userId, action: 'auth.logout', entityType: 'user', entityId: principal.userId });
    }
    const res = NextResponse.json({ ok: true });
    res.cookies.set(SESSION_COOKIE, '', { ...cookieOptions(), maxAge: 0 });
    return res;
  } catch (error) { return errorResponse(error); }
}
