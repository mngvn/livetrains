import { afterEach, describe, expect, it } from 'vitest';
import { ConnectionCounter, RateLimiter } from './rateLimit.js';

const limiters: RateLimiter[] = [];
const limiter = (limit: number, windowMs = 60_000) => {
  const made = new RateLimiter(limit, windowMs);
  limiters.push(made);
  return made;
};
afterEach(() => {
  for (const made of limiters.splice(0)) made.stop();
});

describe('RateLimiter', () => {
  it('lets a client through up to its budget, then refuses until the window resets', () => {
    const limit = limiter(3);
    const t = 1_000_000;
    expect([1, 2, 3].map(() => limit.take('a', t).allowed)).toEqual([true, true, true]);
    const refused = limit.take('a', t + 10);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBe(60);
    expect(limit.take('a', t + 60_000).allowed).toBe(true);
  });

  it('keeps clients apart', () => {
    const limit = limiter(1);
    expect(limit.take('a', 0).allowed).toBe(true);
    expect(limit.take('b', 0).allowed).toBe(true);
    expect(limit.take('a', 1).allowed).toBe(false);
  });

  it('forgets closed windows, so memory follows recent clients only', () => {
    const limit = limiter(5, 1_000);
    for (let i = 0; i < 100; i++) limit.take(`client-${i}`, 0);
    expect(limit.size).toBe(100);
    limit.sweep(1_000);
    expect(limit.size).toBe(0);
  });

  it('is off at zero', () => {
    const limit = limiter(0);
    for (let i = 0; i < 1_000; i++) expect(limit.take('a').allowed).toBe(true);
    expect(limit.size).toBe(0);
  });
});

describe('ConnectionCounter', () => {
  it('caps what one client holds and what everyone holds together', () => {
    const counter = new ConnectionCounter(2, 3);
    const a1 = counter.acquire('a');
    const a2 = counter.acquire('a');
    expect(a1 && a2).toBeTruthy();
    expect(counter.acquire('a')).toBeNull();
    const b1 = counter.acquire('b');
    expect(b1).toBeTruthy();
    expect(counter.acquire('c')).toBeNull();
    a1!();
    // Releasing twice must not free a second slot.
    a1!();
    expect(counter.count).toBe(2);
    expect(counter.acquire('c')).toBeTruthy();
  });
});
