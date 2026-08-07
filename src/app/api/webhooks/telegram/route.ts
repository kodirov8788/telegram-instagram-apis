import { NextRequest, NextResponse } from 'next/server';
import { resolveChannelConnection } from '@/lib/services/webhook-connection-resolver';
import { insertProviderEvent } from '@/lib/services/provider-events';

// POST endpoint for Telegram Bot API incoming updates.
//
// Note: this route resolves its connection (required — provider_events.
// connection_id has a NOT NULL foreign key into channel_connections, so an
// event can't be ledgered without one) but does not add Telegram webhook
// signature verification (`X-Telegram-Bot-Api-Secret-Token`). That's a
// separate, still-open auth gap (pre-existing, same class of issue PR #67
// fixed for Instagram) — out of scope for this change, which is about the
// inbound queue/dedup/retry pipeline, not Telegram-specific auth hardening.
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
