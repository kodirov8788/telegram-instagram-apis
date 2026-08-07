import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verifies a Meta (Facebook/Instagram) webhook payload against its
 * X-Hub-Signature-256 header. Meta signs the raw request body with the
 * app secret using HMAC-SHA256 and sends it as `sha256=<hex digest>`.
 *
 * Must be called with the raw, unparsed request body — the signature is
 * computed over the exact bytes Meta sent, not a re-serialized object.
 */
export function verifyMetaSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  appSecret: string
): boolean {
  if (!signatureHeader || !appSecret) return false;

  const [scheme, providedDigest] = signatureHeader.split('=');
  if (scheme !== 'sha256' || !providedDigest) return false;

  const expectedDigest = createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex');

  const provided = Buffer.from(providedDigest, 'hex');
  const expected = Buffer.from(expectedDigest, 'hex');

  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}
