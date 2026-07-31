import { NextRequest, NextResponse } from 'next/server';
import { MessageNormalizerService } from '@/lib/services/message-queue';
import { AIIntelligenceService } from '@/lib/services/ai-intelligence';

export async function POST(req: NextRequest) {
  try {
    const payload = await req.json();
    console.log('Received Telegram Webhook Payload:', JSON.stringify(payload));

    const workspaceId = req.nextUrl.searchParams.get('workspace_id') || 'default-workspace';
    const normalized = MessageNormalizerService.normalizeTelegramMessage(workspaceId, payload);

    if (normalized) {
      // Process incoming message asynchronously via AI Intelligence Engine
      await AIIntelligenceService.processIncomingMessage(normalized);
    }

    return NextResponse.json({ status: 'ok' });
  } catch (error: any) {
    console.error('Error processing Telegram webhook:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
