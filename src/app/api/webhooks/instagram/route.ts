import { NextRequest, NextResponse } from 'next/server';
import { verifyMetaSignature } from '@/lib/security/meta-signature';
import { resolveChannelConnection } from '@/lib/services/webhook-connection-resolver';
import { insertProviderEvent } from '@/lib/services/provider-events';

// GET endpoint for Meta Webhook verification handshake
export async function GET(req: NextRequest) {
  const mode = req.nextUrl.searchParams.get('hub.mode');
  const token = req.nextUrl.searchParams.get('hub.verify_token');
  const challenge = req.nextUrl.searchParams.get('hub.challenge');

  const VERIFY_TOKEN = process.env.INSTAGRAM_VERIFY_TOKEN;

  // Fail closed: without a configured verify token there is no safe value
  // to compare against, so the handshake cannot succeed.
  if (!VERIFY_TOKEN) {
    console.error('INSTAGRAM_VERIFY_TOKEN is not configured; rejecting webhook handshake.');
    return new Response('Forbidden', { status: 403 });
  }

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return new Response(challenge, { status: 200 });
  }

  return new Response('Forbidden', { status: 403 });
}

// POST endpoint for Meta Instagram incoming message events.
//
// This only authenticates the delivery, resolves its owning connection,
// records it in the provider_events ledger (which also enqueues it), and
// acknowledges — it does not run AI processing inline. That happens in the
// background via the inbound worker (src/lib/workers/processors/inbound.ts),
// so a slow/unavailable AI call can never make Meta's webhook delivery
// time out or retry-storm this endpoint.
export async function POST(req: NextRequest) {
  // Read the raw body first — verification must run over the exact bytes
  // Meta signed. Parsing to JSON before verifying would make the raw bytes
  // unrecoverable for signature comparison.
  const rawBody = await req.text();

  const appSecret = process.env.INSTAGRAM_APP_SECRET;
  const signature = req.headers.get('x-hub-signature-256');

  if (!appSecret || !verifyMetaSignature(rawBody, signature, appSecret)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  try {
    if (payload.object === 'instagram' || payload.object === 'page') {
      for (const entry of payload.entry || []) {
        // `entry.id` is the IG Business Account / Page id the event was
        // delivered to — it is how we determine which workspace owns this
        // message. Entries for accounts with no active connection are
        // ignored (not an error): unconnected/unknown senders are expected
        // traffic, not a failure.
        const connection = await resolveChannelConnection('instagram', entry.id);
        if (!connection) {
          console.warn(`Instagram webhook: no active connection for account ${entry.id}; ignoring entry.`);
          continue;
        }

        for (const messagingEntry of entry.messaging || []) {
          const providerEventId = messagingEntry?.message?.mid;
          if (!providerEventId) continue; // postbacks etc. — not a message event, nothing to queue yet

          await insertProviderEvent({
            workspaceId: connection.workspaceId,
            connectionId: connection.connectionId,
            provider: 'instagram',
            providerEventId,
            payload: messagingEntry,
          });
        }
      }
    }

    return NextResponse.json({ status: 'EVENT_RECEIVED' });
  } catch (error: any) {
    console.error('Error recording Instagram webhook event:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
