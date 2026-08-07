import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyMetaSignature } from '../meta-signature';

const APP_SECRET = 'test-app-secret';
const sign = (body: string, secret = APP_SECRET) => `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;

describe('verifyMetaSignature', () => {
  it('accepts a correctly signed body', () => {
    const body = JSON.stringify({ object: 'instagram', entry: [] });
    expect(verifyMetaSignature(body, sign(body), APP_SECRET)).toBe(true);
  });

  it('rejects a body that was tampered with after signing', () => {
    const original = JSON.stringify({ object: 'instagram', entry: [] });
    const tampered = JSON.stringify({ object: 'instagram', entry: [{ id: 'attacker' }] });
    expect(verifyMetaSignature(tampered, sign(original), APP_SECRET)).toBe(false);
  });

  it('rejects when the signature was produced with a different app secret', () => {
    const body = JSON.stringify({ object: 'instagram', entry: [] });
    expect(verifyMetaSignature(body, sign(body, 'wrong-secret'), APP_SECRET)).toBe(false);
  });

  it('rejects a missing signature header', () => {
    const body = JSON.stringify({ object: 'instagram', entry: [] });
    expect(verifyMetaSignature(body, null, APP_SECRET)).toBe(false);
    expect(verifyMetaSignature(body, undefined, APP_SECRET)).toBe(false);
  });

  it('rejects a malformed signature header (wrong scheme or shape)', () => {
    const body = JSON.stringify({ object: 'instagram', entry: [] });
    expect(verifyMetaSignature(body, 'sha1=deadbeef', APP_SECRET)).toBe(false);
    expect(verifyMetaSignature(body, 'not-a-signature', APP_SECRET)).toBe(false);
    expect(verifyMetaSignature(body, 'sha256=', APP_SECRET)).toBe(false);
  });

  it('rejects when no app secret is configured', () => {
    const body = JSON.stringify({ object: 'instagram', entry: [] });
    expect(verifyMetaSignature(body, sign(body), '')).toBe(false);
  });
});
