import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Constant-time secret comparison. Rejects on any non-string input or length
 * mismatch before ever calling timingSafeEqual, which throws on unequal-length
 * buffers rather than returning false.
 */
export function secretsMatch(expected: string, provided: string | null | undefined): boolean {
  if (typeof provided !== 'string' || provided.length === 0) return false;
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const providedBuffer = Buffer.from(provided, 'utf8');
  if (expectedBuffer.length !== providedBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, providedBuffer);
}

const META_SIGNATURE_PATTERN = /^sha256=([0-9a-f]{64})$/;

/**
 * Verifies Meta's X-Hub-Signature-256 header against the exact raw UTF-8 request
 * bytes. Callers must pass the untouched body text captured via req.text() before
 * any JSON parsing/reserialization, or the signature will not match.
 */
export function verifyMetaSignature(
  appSecret: string,
  rawBody: string,
  header: string | null | undefined,
): boolean {
  if (typeof header !== 'string') return false;
  const match = META_SIGNATURE_PATTERN.exec(header);
  if (!match) return false;

  const providedDigest = Buffer.from(match[1], 'hex');
  const expectedDigest = createHmac('sha256', appSecret).update(rawBody, 'utf8').digest();
  if (providedDigest.length !== expectedDigest.length) return false;
  return timingSafeEqual(providedDigest, expectedDigest);
}
