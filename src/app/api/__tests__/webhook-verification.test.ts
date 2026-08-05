import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createHmac } from 'node:crypto';

const mocks = vi.hoisted(() => ({
  resolveActiveWebhookConnection: vi.fn(),
  normalizeTelegramMessage: vi.fn(),
  normalizeInstagramMessage: vi.fn(),
  processIncomingMessage: vi.fn(),
  dbQuery: vi.fn(),
}));

vi.mock('@/lib/services/webhook-connection-resolver', () => ({
  resolveActiveWebhookConnection: mocks.resolveActiveWebhookConnection,
}));
vi.mock('@/lib/services/message-queue', () => ({ MessageNormalizerService: {
  normalizeTelegramMessage: mocks.normalizeTelegramMessage,
  normalizeInstagramMessage: mocks.normalizeInstagramMessage,
} }));
vi.mock('@/lib/services/ai-intelligence', () => ({
  AIIntelligenceService: { processIncomingMessage: mocks.processIncomingMessage },
}));
vi.mock('@/lib/db', () => ({ query: mocks.dbQuery, default: { connect: vi.fn() } }));

import { POST as telegramPost } from '../webhooks/telegram/route';
import { GET as instagramGet, POST as instagramPost } from '../webhooks/instagram/route';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const workspaceId = '11111111-1111-4111-8111-111111111111';
const connectionId = '22222222-2222-4222-8222-222222222222';
const telegramIdentifier = '33333333-3333-4333-8333-333333333333';
const instagramIdentifier = '44444444-4444-4444-8444-444444444444';

const telegramConnection = {
  id: connectionId,
  workspaceId,
  channel: 'telegram' as const,
  accountIdentifier: 'bot_account',
  credentials: { webhook_secret: 'correct-telegram-secret' },
};

const instagramConnection = {
  id: connectionId,
  workspaceId,
  channel: 'instagram' as const,
  accountIdentifier: 'ig_account',
  credentials: { app_secret: 'correct-app-secret', verify_token: 'correct-verify-token' },
};

function expectNoSideEffects() {
  expect(mocks.normalizeTelegramMessage).not.toHaveBeenCalled();
  expect(mocks.normalizeInstagramMessage).not.toHaveBeenCalled();
  expect(mocks.processIncomingMessage).not.toHaveBeenCalled();
  expect(mocks.dbQuery).not.toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
}

beforeEach(() => { vi.clearAllMocks(); });

describe('Telegram webhook trust boundary', () => {
  const telegramUpdate = {
    update_id: 1,
    message: { message_id: 1, from: { id: 1, is_bot: false, first_name: 'A' }, chat: { id: 1, type: 'private' }, date: 0, text: 'hi' },
  };
  const url = `https://app.test/api/webhooks/telegram?connection=${telegramIdentifier}`;

  it('rejects a request missing the Telegram secret header', async () => {
    mocks.resolveActiveWebhookConnection.mockResolvedValueOnce(telegramConnection);
    const req = new NextRequest(url, { method: 'POST', body: JSON.stringify(telegramUpdate) });
    const res = await telegramPost(req);
    expect(res.status).toBe(401);
    expectNoSideEffects();
  });

  it('rejects a request with an incorrect Telegram secret header', async () => {
    mocks.resolveActiveWebhookConnection.mockResolvedValueOnce(telegramConnection);
    const req = new NextRequest(url, {
      method: 'POST',
      headers: { 'x-telegram-bot-api-secret-token': 'wrong-secret' },
      body: JSON.stringify(telegramUpdate),
    });
    const res = await telegramPost(req);
    expect(res.status).toBe(401);
    expectNoSideEffects();
  });

  it('rejects an unknown webhook locator', async () => {
    mocks.resolveActiveWebhookConnection.mockResolvedValueOnce(null);
    const req = new NextRequest(url, {
      method: 'POST',
      headers: { 'x-telegram-bot-api-secret-token': 'correct-telegram-secret' },
      body: JSON.stringify(telegramUpdate),
    });
    const res = await telegramPost(req);
    expect(res.status).toBe(401);
    expectNoSideEffects();
    expect(mocks.resolveActiveWebhookConnection).toHaveBeenCalledWith('telegram', telegramIdentifier);
  });

  it('rejects an inactive connection identically to an unknown one', async () => {
    // Resolver query filters is_active = TRUE, so inactive connections resolve to null.
    mocks.resolveActiveWebhookConnection.mockResolvedValueOnce(null);
    const req = new NextRequest(url, {
      method: 'POST',
      headers: { 'x-telegram-bot-api-secret-token': 'correct-telegram-secret' },
      body: JSON.stringify(telegramUpdate),
    });
    const res = await telegramPost(req);
    expect(res.status).toBe(401);
    expectNoSideEffects();
  });

  it('accepts a valid secret and derives the workspace from the resolved connection', async () => {
    mocks.resolveActiveWebhookConnection.mockResolvedValueOnce(telegramConnection);
    mocks.normalizeTelegramMessage.mockReturnValueOnce({ workspaceId, channel: 'telegram', channelUserIdentifier: '1', content: 'hi', messageType: 'text', rawPayload: telegramUpdate });
    mocks.processIncomingMessage.mockResolvedValueOnce(undefined);

    const req = new NextRequest(url, {
      method: 'POST',
      headers: { 'x-telegram-bot-api-secret-token': 'correct-telegram-secret' },
      body: JSON.stringify(telegramUpdate),
    });
    const res = await telegramPost(req);

    expect(res.status).toBe(200);
    expect(mocks.normalizeTelegramMessage).toHaveBeenCalledWith(workspaceId, telegramUpdate);
    expect(mocks.processIncomingMessage).toHaveBeenCalledTimes(1);
  });
});

describe('Instagram webhook POST trust boundary', () => {
  const rawBody = JSON.stringify({
    object: 'instagram',
    entry: [{ id: 'ig-account', time: 0, messaging: [{ sender: { id: 'user-1' }, recipient: { id: 'page-1' }, timestamp: 0, message: { mid: 'm1', text: 'hi' } }] }],
  });
  const url = `https://app.test/api/webhooks/instagram?connection=${instagramIdentifier}`;
  const sign = (secret: string, body: string) => `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;

  it('rejects a request missing X-Hub-Signature-256', async () => {
    mocks.resolveActiveWebhookConnection.mockResolvedValueOnce(instagramConnection);
    const req = new NextRequest(url, { method: 'POST', body: rawBody });
    const res = await instagramPost(req);
    expect(res.status).toBe(401);
    expectNoSideEffects();
  });

  it('rejects a well-formed but incorrect signature', async () => {
    mocks.resolveActiveWebhookConnection.mockResolvedValueOnce(instagramConnection);
    const badSig = `sha256=${'0'.repeat(64)}`;
    const req = new NextRequest(url, { method: 'POST', headers: { 'x-hub-signature-256': badSig }, body: rawBody });
    const res = await instagramPost(req);
    expect(res.status).toBe(401);
    expectNoSideEffects();
  });

  it('rejects a modified body sent with the original signature', async () => {
    mocks.resolveActiveWebhookConnection.mockResolvedValueOnce(instagramConnection);
    const validSigForOriginal = sign('correct-app-secret', rawBody);
    const tamperedBody = rawBody.replace('hi', 'hacked');
    const req = new NextRequest(url, { method: 'POST', headers: { 'x-hub-signature-256': validSigForOriginal }, body: tamperedBody });
    const res = await instagramPost(req);
    expect(res.status).toBe(401);
    expectNoSideEffects();
  });

  it('rejects an unknown webhook locator even with a well-formed signature', async () => {
    mocks.resolveActiveWebhookConnection.mockResolvedValueOnce(null);
    const sig = sign('correct-app-secret', rawBody);
    const req = new NextRequest(url, { method: 'POST', headers: { 'x-hub-signature-256': sig }, body: rawBody });
    const res = await instagramPost(req);
    expect(res.status).toBe(401);
    expectNoSideEffects();
  });

  it('rejects an inactive connection identically to an unknown one', async () => {
    mocks.resolveActiveWebhookConnection.mockResolvedValueOnce(null);
    const sig = sign('correct-app-secret', rawBody);
    const req = new NextRequest(url, { method: 'POST', headers: { 'x-hub-signature-256': sig }, body: rawBody });
    const res = await instagramPost(req);
    expect(res.status).toBe(401);
    expectNoSideEffects();
  });

  it('accepts a valid signature and derives the workspace from the resolved connection', async () => {
    mocks.resolveActiveWebhookConnection.mockResolvedValueOnce(instagramConnection);
    mocks.normalizeInstagramMessage.mockReturnValueOnce({ workspaceId, channel: 'instagram', channelUserIdentifier: 'user-1', content: 'hi', messageType: 'text', rawPayload: {} });
    mocks.processIncomingMessage.mockResolvedValueOnce(undefined);

    const sig = sign('correct-app-secret', rawBody);
    const req = new NextRequest(url, { method: 'POST', headers: { 'x-hub-signature-256': sig }, body: rawBody });
    const res = await instagramPost(req);

    expect(res.status).toBe(200);
    expect(mocks.normalizeInstagramMessage).toHaveBeenCalledTimes(1);
    expect(mocks.normalizeInstagramMessage.mock.calls[0][0]).toBe(workspaceId);
    expect(mocks.processIncomingMessage).toHaveBeenCalledTimes(1);
  });
});

describe('Instagram webhook GET handshake', () => {
  const baseUrl = `https://app.test/api/webhooks/instagram?connection=${instagramIdentifier}`;

  it('rejects the removed checked-in default verify token', async () => {
    delete process.env.INSTAGRAM_VERIFY_TOKEN;
    mocks.resolveActiveWebhookConnection.mockResolvedValueOnce(instagramConnection);
    const req = new NextRequest(`${baseUrl}&hub.mode=subscribe&hub.verify_token=ydeck_secret_token_123&hub.challenge=abc`);
    const res = await instagramGet(req);
    expect(res.status).toBe(403);
  });

  it('returns the exact challenge for the correct per-connection verify token', async () => {
    mocks.resolveActiveWebhookConnection.mockResolvedValueOnce(instagramConnection);
    const req = new NextRequest(`${baseUrl}&hub.mode=subscribe&hub.verify_token=correct-verify-token&hub.challenge=abc123`);
    const res = await instagramGet(req);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('abc123');
  });

  it('rejects a mismatched token', async () => {
    mocks.resolveActiveWebhookConnection.mockResolvedValueOnce(instagramConnection);
    const req = new NextRequest(`${baseUrl}&hub.mode=subscribe&hub.verify_token=nope&hub.challenge=abc`);
    expect((await instagramGet(req)).status).toBe(403);
  });

  it('rejects a non-subscribe mode without consulting the resolver', async () => {
    const req = new NextRequest(`${baseUrl}&hub.mode=unsubscribe&hub.verify_token=correct-verify-token&hub.challenge=abc`);
    expect((await instagramGet(req)).status).toBe(403);
    expect(mocks.resolveActiveWebhookConnection).not.toHaveBeenCalled();
  });

  it('rejects an unknown webhook locator', async () => {
    mocks.resolveActiveWebhookConnection.mockResolvedValueOnce(null);
    const req = new NextRequest(`${baseUrl}&hub.mode=subscribe&hub.verify_token=correct-verify-token&hub.challenge=abc`);
    expect((await instagramGet(req)).status).toBe(403);
  });
});
