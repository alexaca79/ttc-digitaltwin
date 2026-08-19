import { describe, expect, it } from 'vitest';

import { createRateLimiter } from '../../ingest/snapshotServer.js';

describe('publisher rate limiting', () => {
  it('allows requests up to the limit and rejects the next one', () => {
    const consume = createRateLimiter(3);
    const now = 1_000_000;

    expect(consume('1.2.3.4', now).allowed).toBe(true);
    expect(consume('1.2.3.4', now).allowed).toBe(true);
    expect(consume('1.2.3.4', now).allowed).toBe(true);

    const blocked = consume('1.2.3.4', now);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('tracks callers independently', () => {
    const consume = createRateLimiter(1);
    const now = 2_000_000;

    expect(consume('1.1.1.1', now).allowed).toBe(true);
    expect(consume('2.2.2.2', now).allowed).toBe(true);
    expect(consume('1.1.1.1', now).allowed).toBe(false);
  });

  it('restores the allowance once the window rolls over', () => {
    const consume = createRateLimiter(1);
    const now = 3_000_000;

    expect(consume('9.9.9.9', now).allowed).toBe(true);
    expect(consume('9.9.9.9', now + 30_000).allowed).toBe(false);
    expect(consume('9.9.9.9', now + 60_001).allowed).toBe(true);
  });

  it('disables throttling when the limit is zero', () => {
    const consume = createRateLimiter(0);
    const now = 4_000_000;

    for (let attempt = 0; attempt < 500; attempt += 1) {
      expect(consume('8.8.8.8', now).allowed).toBe(true);
    }
  });
});
