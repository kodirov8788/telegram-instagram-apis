import { describe, expect, it } from 'vitest';
import { secretsMatch } from '../webhook-secret';

describe('secretsMatch', () => {
  it('accepts a matching secret', () => {
    expect(secretsMatch('whsec_abc123', 'whsec_abc123')).toBe(true);
  });

  it('rejects a mismatched secret', () => {
    expect(secretsMatch('whsec_abc123', 'whsec_wrong')).toBe(false);
  });

  it('rejects when the provided secret is missing', () => {
    expect(secretsMatch('whsec_abc123', null)).toBe(false);
    expect(secretsMatch('whsec_abc123', undefined)).toBe(false);
  });

  it('rejects when no expected secret is configured', () => {
    expect(secretsMatch(null, 'anything')).toBe(false);
    expect(secretsMatch(undefined, 'anything')).toBe(false);
    expect(secretsMatch('', 'anything')).toBe(false);
  });

  it('rejects a same-prefix secret of different length rather than throwing', () => {
    expect(secretsMatch('whsec_abc123', 'whsec_abc123extra')).toBe(false);
  });
});
