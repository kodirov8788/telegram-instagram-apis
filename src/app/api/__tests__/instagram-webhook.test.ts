import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/db', () => ({ query: vi.fn(), default: { connect: vi.fn() } }));
vi.mock('@/lib/services/provider-events', () => ({ insertProviderEvent: vi.fn() }));

import { query } from '@/lib/db';
import { insertProviderEvent } from '@/lib/services/provider-events';
import { GET, POST } from '../webhooks/instagram/route';

const db = vi.mocked(query);
const insert = vi.mocked(insertProviderEvent);

const APP_SECRET = 'test-app-secret';
const sign = (body: string) => `sha256=${createHmac('sha256', APP_SECRET).update(body, 'utf8').digest('hex')}`;
const originalEnv = { ...process.env };

beforeEach(() => {
  db.mockReset();
  insert.mockReset();
  insert.mockResolvedValue({ id: 'event-1', status: 'queued', isDuplicate: false });
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
});

describe('Instagram webhook POST (fast-ack + enqueue, no inline AI processing)', () => {
  const payload = {
    object: 'instagram',
    entry: [
      {
        id: 'ig-account-123',
        messaging: [
          { sender: { id: 'ig-user-1' }, recipient: { id: 'ig-account-123' }, message: { mid: 'mid-1', text: 'Hello' } },
        ],
      },
    ],
  };
  const body = JSON.stringify(payload);

  it('rejects a request with a missing signature and never touches the ledger', async () => {
    const req = new NextRequest('https://app.test/api/webhooks/instagram', { method: 'POST', body });
    const res = await POST(req);
    expect(res.status).toBe(401);
    expect(insert).not.toHaveBeenCalled();
  });

  it('rejects a tampered body even with a present signature header', async () => {
    const req = new NextRequest('https://app.test/api/webhooks/instagram', {
      method: 'POST',
      headers: { 'x-hub-signature-256': sign('{"object":"instagram","entry":[]}') },
      body,
    });
    expect((await POST(req)).status).toBe(401);
    expect(insert).not.toHaveBeenCalled();
  });

  it('ignores a validly signed event when the account has no active connection', async () => {
    db.mockResolvedValueOnce({ rows: [] } as never); // resolveChannelConnection: no match

    const req = new NextRequest('https://app.test/api/webhooks/instagram', {
      method: 'POST',
      headers: { 'x-hub-signature-256': sign(body) },
      body,
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(insert).not.toHaveBeenCalled();
  });

  it('resolves the connection and records the event in the ledger instead of processing it inline', async () => {
    db.mockResolvedValueOnce({
      rows: [{ id: 'conn-1', workspace_id: 'ws-resolved', credentials: {} }],
    } as never);

    const req = new NextRequest('https://app.test/api/webhooks/instagram', {
      method: 'POST',
      headers: { 'x-hub-signature-256': sign(body) },
      body,
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-resolved',
        connectionId: 'conn-1',
        provider: 'instagram',
        providerEventId: 'mid-1',
      })
    );
  });

  it('rejects malformed JSON even with a valid signature over that malformed body', async () => {
    const malformed = '{not valid json';
    const req = new NextRequest('https://app.test/api/webhooks/instagram', {
      method: 'POST',
      headers: { 'x-hub-signature-256': sign(malformed) },
      body: malformed,
    });
    expect((await POST(req)).status).toBe(400);
    expect(insert).not.toHaveBeenCalled();
  });
});
