import { NextRequest, NextResponse } from 'next/server';
import { MessageNormalizerService } from '@/lib/services/message-queue';
import { AIIntelligenceService } from '@/lib/services/ai-intelligence';
import { resolveActiveWebhookConnection } from '@/lib/services/webhook-connection-resolver';
import { secretsMatch, verifyMetaSignature } from '@/lib/security/webhook-verification';

const forbidden = () => new Response('Forbidden', { status: 403 });
const unauthorized = () => NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

export async function GET(req: NextRequest) {
  const identifier = req.nextUrl.searchParams.get('connection');
  const mode = req.nextUrl.searchParams.get('hub.mode');
  const token = req.nextUrl.searchParams.get('hub.verify_token');
  const challenge = req.nextUrl.searchParams.get('hub.challenge');
  if (!identifier || mode !== 'subscribe' || !challenge) return forbidden();

  const connection = await resolveActiveWebhookConnection('instagram', identifier);
  const expectedToken = connection?.credentials.verify_token;
  if (!connection || typeof expectedToken !== 'string' || !secretsMatch(expectedToken, token)) return forbidden();
  return new Response(challenge, { status: 200 });
}

export async function POST(req: NextRequest) {
  const identifier = req.nextUrl.searchParams.get('connection');
  const rawBody = await req.text();
  const signatureHeader = req.headers.get('x-hub-signature-256');
  if (!identifier) return unauthorized();

  const connection = await resolveActiveWebhookConnection('instagram', identifier);
  const appSecret = connection?.credentials.app_secret;
  if (!connection || typeof appSecret !== 'string' || !verifyMetaSignature(appSecret, rawBody, signatureHeader)) return unauthorized();

  let payload: any;
  try { payload = JSON.parse(rawBody); }
  catch { return NextResponse.json({ error: 'Bad Request' }, { status: 400 }); }

  try {
    if (payload.object === 'instagram' || payload.object === 'page') {
      for (const entry of payload.entry ?? []) {
        for (const messagingEntry of entry.messaging ?? []) {
          const normalized = MessageNormalizerService.normalizeInstagramMessage(connection.workspaceId, messagingEntry);
          if (normalized) await AIIntelligenceService.processIncomingMessage(normalized);
        }
      }
    }
    return NextResponse.json({ status: 'EVENT_RECEIVED' });
  } catch {
    console.error('Instagram webhook processing failed', { connectionId: connection.id });
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}