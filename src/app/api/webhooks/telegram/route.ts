import { NextRequest, NextResponse } from 'next/server';
import { resolveChannelConnection } from '@/lib/services/webhook-connection-resolver';
import { getConnectionSecret } from '@/lib/services/connection-secret-loader';
import { insertProviderEvent } from '@/lib/services/provider-events';
import { secretsMatch } from '@/lib/security/webhook-secret';

// POST endpoint for Telegram Bot API incoming updates.
//
// Authenticated via Telegram's `X-Telegram-Bot-Api-Secret-Token` header: set
// once per bot via `setWebhook({ secret_token })` and echoed back on every
// delivery. The `connection` query param identifies which bot (its
// account_identifier is public — a Telegram bot username — so resolving it
// alone proves nothing); the secret token, stored in that connection's
// credentials and known only to whoever configured the webhook, is what
// actually authorizes queueing work under that workspace. Without this
// check, anyone who knows or guesses a workspace's public bot username
// could inject fabricated "customer" messages into that workspace's queue.
export async function POST(req: NextRequest) {
  const identifier = req.nextUrl.searchParams.get('connection');
  if (!identifier) {
    return NextResponse.json({ error: 'Missing connection identifier' }, { status: 400 });
  }

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  try {
    const connection = await resolveChannelConnection('telegram', identifier);
    if (!connection) {
      console.warn(`Telegram webhook: no active connection for identifier ${identifier}; ignoring update.`);
      return NextResponse.json({ status: 'ok' });
    }

    const secret = await getConnectionSecret(connection.connectionId, connection.workspaceId);
    const expectedSecret = secret?.webhookSecret;
    const providedSecret = req.headers.get('x-telegram-bot-api-secret-token');
    if (typeof expectedSecret !== 'string' || !secretsMatch(expectedSecret, providedSecret)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // update_id is unique per bot per Telegram update; not present on every
    // update type, but this route only cares about message updates today.
    if (payload?.message && typeof payload.update_id === 'number') {
      await insertProviderEvent({
        workspaceId: connection.workspaceId,
        connectionId: connection.connectionId,
        provider: 'telegram',
        providerEventId: String(payload.update_id),
        payload,
      });
    }

    return NextResponse.json({ status: 'ok' });
  } catch (error: any) {
    console.error('Error recording Telegram webhook event:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
