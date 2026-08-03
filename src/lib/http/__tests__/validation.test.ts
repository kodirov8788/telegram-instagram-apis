import { describe, expect, it } from 'vitest';
import { parseBody, uuid } from '../validation';
import { z } from 'zod';

describe('request validation', () => {
  it('rejects malformed JSON as a 400 response error', async () => {
    const req = new Request('https://app.test', { method: 'POST', body: '{' });
    await expect(parseBody(req, z.object({ name: z.string() }))).rejects.toMatchObject({ status: 400 });
  });
  it('rejects non-UUID identifiers', () => expect(() => uuid.parse('default-workspace')).toThrow());
  it('rejects unknown body properties', async () => {
    const req = new Request('https://app.test', { method: 'POST', body: JSON.stringify({ name: 'ok', ownerUserId: 'attacker' }) });
    await expect(parseBody(req, z.object({ name: z.string() }).strict())).rejects.toMatchObject({ status: 400 });
  });
});
