import { NextRequest, NextResponse } from 'next/server';
import { resolveActiveWebhookConnection } from '@/lib/services/webhook-connection-resolver';
import { secretsMatch } from '@/lib/security/webhook-verification';
import { insertProviderEvent } from '@/lib/services/provider-events';

const unauthorized = () => NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

export async function POST(req: NextRequest) {
  const identifier = req.nextUrl.searchParams.get('connection');
  const rawBody = await req.text();
  const secretHeader = req.headers.get('x-telegram-bot-api-secret-token');
  if (!identifier) return unauthorized();

  const connection = await resolveActiveWebhookConnection('telegram', identifier);
  const expectedSecret = connection?.credentials.webhook_secret;
  if (!connection || typeof expectedSecret !== 'string' || !secretsMatch(expectedSecret, secretHeader)) return unauthorized();

  let payload: any;
  try { payload = JSON.parse(rawBody); }
  catch { return NextResponse.json({ error: 'Bad Request' }, { status: 400 }); }

  try {
    // Ignore non-message items safely (Telegram requires payload.message to exist)
    if (payload && payload.message && typeof payload.update_id === 'number') {
      await insertProviderEvent({
        workspaceId: connection.workspaceId,
        connectionId: connection.id,
        provider: 'telegram',
        providerEventId: payload.update_id.toString(),
        payload: payload,
        webhookIdentifier: identifier,
      });
    }
    return NextResponse.json({ status: 'ok' });
  } catch {
    console.error('Telegram webhook processing failed', { connectionId: connection.id });
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}