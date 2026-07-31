import { NextRequest, NextResponse } from 'next/server';
import { MessageNormalizerService } from '@/lib/services/message-queue';
import { AIIntelligenceService } from '@/lib/services/ai-intelligence';

// GET endpoint for Meta Webhook verification handshake
export async function GET(req: NextRequest) {
  const mode = req.nextUrl.searchParams.get('hub.mode');
  const token = req.nextUrl.searchParams.get('hub.verify_token');
  const challenge = req.nextUrl.searchParams.get('hub.challenge');

  const VERIFY_TOKEN = process.env.INSTAGRAM_VERIFY_TOKEN || 'ydeck_secret_token_123';

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Instagram Webhook Verified Successfully');
    return new Response(challenge, { status: 200 });
  } else {
    return new Response('Forbidden', { status: 403 });
  }
}

// POST endpoint for Meta Instagram incoming message events
export async function POST(req: NextRequest) {
  try {
    const payload = await req.json();
    console.log('Received Instagram Webhook Event:', JSON.stringify(payload));

    const workspaceId = req.nextUrl.searchParams.get('workspace_id') || 'default-workspace';

    if (payload.object === 'instagram' || payload.object === 'page') {
      for (const entry of payload.entry || []) {
        for (const messagingEntry of entry.messaging || []) {
          const normalized = MessageNormalizerService.normalizeInstagramMessage(workspaceId, messagingEntry);
          if (normalized) {
            await AIIntelligenceService.processIncomingMessage(normalized);
          }
        }
      }
    }

    return NextResponse.json({ status: 'EVENT_RECEIVED' });
  } catch (error: any) {
    console.error('Error processing Instagram webhook:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
