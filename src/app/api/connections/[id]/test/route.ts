import { NextRequest, NextResponse } from 'next/server';
import { withLiveAuthorization } from '@/lib/auth/session';
import { errorResponse, HttpError, parseValue, uuid } from '@/lib/http/validation';
import { ConnectionsService } from '@/lib/services/connections';
import { getConnectionSecret } from '@/lib/services/connection-secret-loader';

const target = (ctx: { params: Promise<{ id: string }> }) => ctx.params.then(p => parseValue(p.id, uuid));

/**
 * The ONLY endpoint permitted to make a live provider call. No background
 * job, cron, or other route may call this logic implicitly — verifying a
 * credential is expensive/rate-limited on the provider side and must stay
 * an explicit, user-triggered action (see issue #91 non-goals).
 *
 * Response is always `{ ok, detail? }` — `detail` is a short, fixed,
 * non-provider-echoing string. Provider response bodies and thrown errors
 * are never forwarded verbatim, since either could embed the very token
 * being tested (e.g. some providers echo the request URL, which could
 * contain a token query param, back in an error body).
 */
async function testTelegram(token: string): Promise<{ ok: boolean; detail?: string }> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, { method: 'GET' });
    const body = await res.json().catch(() => null);
    if (res.ok && body?.ok) return { ok: true };
    return { ok: false, detail: 'Telegram rejected the stored credential' };
  } catch {
    return { ok: false, detail: 'Could not reach Telegram' };
  }
}

async function testInstagram(accessToken: string): Promise<{ ok: boolean; detail?: string }> {
  try {
    const res = await fetch(`https://graph.facebook.com/v19.0/me?access_token=${encodeURIComponent(accessToken)}`, { method: 'GET' });
    const body = await res.json().catch(() => null);
    if (res.ok && body?.id) return { ok: true };
    return { ok: false, detail: 'Instagram rejected the stored credential' };
  } catch {
    return { ok: false, detail: 'Could not reach Instagram' };
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const id = await target(ctx);

    const result = await withLiveAuthorization(req, 'connections:write', async (p, client) => {
      const connection = await ConnectionsService.getConnection(p.workspaceId, id, client);
      if (!connection) throw new HttpError(404, 'Connection not found');

      const secret = await getConnectionSecret(id, p.workspaceId);
      if (!secret) return { ok: false, detail: 'No stored credential for this connection' };

      const token = typeof secret.token === 'string' ? secret.token
        : typeof secret.access_token === 'string' ? secret.access_token
        : typeof secret.accessToken === 'string' ? secret.accessToken
        : null;
      if (!token) return { ok: false, detail: 'Stored credential is not in a recognized shape' };

      if (connection.channel === 'telegram') return testTelegram(token);
      if (connection.channel === 'instagram') return testInstagram(token);
      return { ok: false, detail: 'Unsupported channel' };
    });

    return NextResponse.json(result);
  } catch (error) { return errorResponse(error); }
}
