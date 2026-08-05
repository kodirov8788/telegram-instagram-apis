import { NextRequest, NextResponse } from 'next/server';
import { MessageNormalizerService } from '@/lib/services/message-queue';
import { AIIntelligenceService } from '@/lib/services/ai-intelligence';
import { resolveActiveWebhookConnection } from '@/lib/services/webhook-connection-resolver';
import { secretsMatch } from '@/lib/security/webhook-verification';

const unauthorized = () => NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

export async function POST(req: NextRequest) {
  const identifier = req.nextUrl.searchParams.get('connection');
  const rawBody = await req.text();
  const secretHeader = req.headers.get('x-telegram-bot-api-secret-token');
  if (!identifier) return unauthorized();

  const connection = await resolveActiveWebhookConnection('telegram', identifier);
  const expectedSecret = connection?.credentials.webhook_secret;
  if (!connection || typeof expectedSecret !== 'string' || !secretsMatch(expectedSecret, secretHeader)) return unauthorized();

  let payload: unknown;
  try { payload = JSON.parse(rawBody); }
  catch { return NextResponse.json({ error: 'Bad Request' }, { status: 400 }); }

  try {
    const normalized = MessageNormalizerService.normalizeTelegramMessage(connection.workspaceId, payload);
    if (normalized) await AIIntelligenceService.processIncomingMessage(normalized);
    return NextResponse.json({ status: 'ok' });
  } catch {
    console.error('Telegram webhook processing failed', { connectionId: connection.id });
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}