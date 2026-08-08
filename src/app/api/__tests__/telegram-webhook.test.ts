import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/db', () => ({ query: vi.fn(), default: { connect: vi.fn() } }));
vi.mock('@/lib/services/provider-events', () => ({ insertProviderEvent: vi.fn() }));

import { query } from '@/lib/db';
import { insertProviderEvent } from '@/lib/services/provider-events';
import { POST } from '../webhooks/telegram/route';

const db = vi.mocked(query);
const insert = vi.mocked(insertProviderEvent);
const SECRET = 'whsec_test_123';

beforeEach(() => {
  db.mockReset();
  insert.mockReset();
  insert.mockResolvedValue({ id: 'event-1', status: 'queued', isDuplicate: false });
});

const req = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(url, { method: 'POST', body: JSON.stringify(body), headers });

const withSecretConnection = () => {
  db.mockResolvedValueOnce({ rows: [{ id: 'conn-1', workspace_id: 'ws-1' }] } as never);
  db.mockResolvedValueOnce({ rows: [{ secret: JSON.stringify({ webhookSecret: SECRET }) }] } as never);
};

describe('Telegram webhook POST (fast-ack + enqueue, secret-token authenticated)', () => {
  it('rejects a request with no connection identifier', async () => {
    const res = await POST(req('https://app.test/api/webhooks/telegram', { update_id: 1 }));
    expect(res.status).toBe(400);
    expect(insert).not.toHaveBeenCalled();
  });

  it('ignores an update from an identifier with no active connection instead of guessing a workspace', async () => {
    db.mockResolvedValueOnce({ rows: [] } as never);

    const res = await POST(
      req('https://app.test/api/webhooks/telegram?connection=some_bot', {
        update_id: 1,
        message: { from: { id: 1, first_name: 'A' }, text: 'hi' },
      })
    );

    expect(res.status).toBe(200);
    expect(insert).not.toHaveBeenCalled();
  });

  it('rejects a resolvable connection when no secret-token header is sent (no cross-tenant injection via a guessed public bot username)', async () => {
    withSecretConnection();

    const res = await POST(
      req('https://app.test/api/webhooks/telegram?connection=some_bot', {
        update_id: 1,
        message: { from: { id: 1, first_name: 'A' }, text: 'hi' },
      })
    );

    expect(res.status).toBe(401);
    expect(insert).not.toHaveBeenCalled();
  });

  it('rejects a wrong secret-token header', async () => {
    withSecretConnection();

    const res = await POST(
      req(
        'https://app.test/api/webhooks/telegram?connection=some_bot',
        { update_id: 1, message: { from: { id: 1, first_name: 'A' }, text: 'hi' } },
        { 'x-telegram-bot-api-secret-token': 'wrong-secret' }
      )
    );

    expect(res.status).toBe(401);
    expect(insert).not.toHaveBeenCalled();
  });

  it('rejects when the connection has no secret configured (fails closed, never accepts an unverifiable request)', async () => {
    db.mockResolvedValueOnce({ rows: [{ id: 'conn-1', workspace_id: 'ws-1' }] } as never);
    db.mockResolvedValueOnce({ rows: [{ secret: JSON.stringify({}) }] } as never);

    const res = await POST(
      req(
        'https://app.test/api/webhooks/telegram?connection=some_bot',
        { update_id: 1, message: { from: { id: 1, first_name: 'A' }, text: 'hi' } },
        { 'x-telegram-bot-api-secret-token': 'anything' }
      )
    );

    expect(res.status).toBe(401);
    expect(insert).not.toHaveBeenCalled();
  });

  it('resolves the connection and records the event in the ledger when the secret token matches', async () => {
    withSecretConnection();

    const res = await POST(
      req(
        'https://app.test/api/webhooks/telegram?connection=some_bot',
        { update_id: 42, message: { from: { id: 1, first_name: 'A' }, text: 'hi' } },
        { 'x-telegram-bot-api-secret-token': SECRET }
      )
    );

    expect(res.status).toBe(200);
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws-1', connectionId: 'conn-1', provider: 'telegram', providerEventId: '42' })
    );
  });

  it('does not enqueue non-message updates even with a valid secret token', async () => {
    withSecretConnection();

    const res = await POST(
      req('https://app.test/api/webhooks/telegram?connection=some_bot', { update_id: 1 }, { 'x-telegram-bot-api-secret-token': SECRET })
    );

    expect(res.status).toBe(200);
    expect(insert).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON', async () => {
    const badReq = new NextRequest('https://app.test/api/webhooks/telegram?connection=some_bot', {
      method: 'POST',
      body: '{not valid json',
    });
    expect((await POST(badReq)).status).toBe(400);
  });
});
