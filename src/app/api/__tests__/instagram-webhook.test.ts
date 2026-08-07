import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/db', () => ({ query: vi.fn(), default: { connect: vi.fn() } }));
vi.mock('@/lib/services/ai-intelligence', () => ({
  AIIntelligenceService: { processIncomingMessage: vi.fn() },
}));

import { query } from '@/lib/db';
import { AIIntelligenceService } from '@/lib/services/ai-intelligence';
import { GET, POST } from '../webhooks/instagram/route';

const db = vi.mocked(query);
const processIncomingMessage = vi.mocked(AIIntelligenceService.processIncomingMessage);

const APP_SECRET = 'test-app-secret';
const sign = (body: string) => `sha256=${createHmac('sha256', APP_SECRET).update(body, 'utf8').digest('hex')}`;

const originalEnv = { ...process.env };

beforeEach(() => {
  db.mockReset();
  processIncomingMessage.mockReset();
  process.env = { ...originalEnv, INSTAGRAM_APP_SECRET: APP_SECRET, INSTAGRAM_VERIFY_TOKEN: 'verify-token-123' };
});

describe('Instagram webhook GET (verification handshake)', () => {
  it('accepts a matching verify token', async () => {
    const req = new NextRequest(
      'https://app.test/api/webhooks/instagram?hub.mode=subscribe&hub.verify_token=verify-token-123&hub.challenge=challenge-value'
    );
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('challenge-value');
  });

  it('rejects a wrong verify token', async () => {
    const req = new NextRequest(
      'https://app.test/api/webhooks/instagram?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=challenge-value'
    );
    expect((await GET(req)).status).toBe(403);
  });

  it('fails closed when INSTAGRAM_VERIFY_TOKEN is not configured', async () => {
    delete process.env.INSTAGRAM_VERIFY_TOKEN;
    const req = new NextRequest(
      'https://app.test/api/webhooks/instagram?hub.mode=subscribe&hub.verify_token=anything&hub.challenge=challenge-value'
    );
    expect((await GET(req)).status).toBe(403);
  });
});

describe('Instagram webhook POST (message ingestion)', () => {
  const payload = {
    object: 'instagram',
    entry: [
      {
        id: 'ig-account-123',
        messaging: [
          {
            sender: { id: 'ig-user-1' },
            recipient: { id: 'ig-account-123' },
            message: { mid: 'mid-1', text: 'Hello' },
          },
        ],
      },
    ],
  };
  const body = JSON.stringify(payload);

  it('rejects a request with a missing signature', async () => {
    const req = new NextRequest('https://app.test/api/webhooks/instagram', { method: 'POST', body });
    const res = await POST(req);
    expect(res.status).toBe(401);
    expect(db).not.toHaveBeenCalled();
    expect(processIncomingMessage).not.toHaveBeenCalled();
  });

  it('rejects a request with an invalid signature (tampered body)', async () => {
    const req = new NextRequest('https://app.test/api/webhooks/instagram', {
      method: 'POST',
      headers: { 'x-hub-signature-256': sign('{"object":"instagram","entry":[]}') },
      body,
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
    expect(processIncomingMessage).not.toHaveBeenCalled();
  });

  it('accepts a validly signed event but ignores it when the account has no active connection', async () => {
    db.mockResolvedValueOnce({ rows: [] } as never); // resolveChannelConnection: no match

    const req = new NextRequest('https://app.test/api/webhooks/instagram', {
      method: 'POST',
      headers: { 'x-hub-signature-256': sign(body) },
      body,
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(processIncomingMessage).not.toHaveBeenCalled();
  });

  it('resolves the workspace/connection from the connected account and processes the message with it (never a hardcoded workspace)', async () => {
    db.mockResolvedValueOnce({
      rows: [{ id: 'conn-1', workspace_id: 'ws-resolved', credentials: { pageAccessToken: 'tok' } }],
    } as never);

    const req = new NextRequest('https://app.test/api/webhooks/instagram', {
      method: 'POST',
      headers: { 'x-hub-signature-256': sign(body) },
      body,
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(processIncomingMessage).toHaveBeenCalledTimes(1);
    const dto = processIncomingMessage.mock.calls[0][0];
    expect(dto.workspaceId).toBe('ws-resolved');
    expect(dto.connectionId).toBe('conn-1');
    expect(dto.workspaceId).not.toBe('default-workspace');
    expect(dto.channelUserIdentifier).toBe('ig-user-1');
    expect(dto.content).toBe('Hello');
  });

  it('rejects malformed JSON even with a valid signature over that malformed body', async () => {
    const malformed = '{not valid json';
    const req = new NextRequest('https://app.test/api/webhooks/instagram', {
      method: 'POST',
      headers: { 'x-hub-signature-256': sign(malformed) },
      body: malformed,
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(processIncomingMessage).not.toHaveBeenCalled();
  });
});
