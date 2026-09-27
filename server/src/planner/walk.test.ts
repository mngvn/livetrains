import { describe, expect, it } from 'vitest';
import { DEFAULT_CIRCUITY, estimateWalk, searchRadiusFor, walkDistance } from './walk.js';

describe('walking estimates', () => {
  it('walks further than the crow flies', () => {
    expect(walkDistance(1_000)).toBeGreaterThan(1_000);
    expect(walkDistance(1_000)).toBeCloseTo(1_000 * DEFAULT_CIRCUITY, 6);
  });

  it('collapses to the straight line when circuity is 1', () => {
    expect(walkDistance(742, 1)).toBe(742);
    expect(estimateWalk(742, 1, 1)).toEqual({ meters: 742, seconds: 742 });
  });

  it('applies walking speed to the real path, not the straight line', () => {
    const speed = 1.33;
    const straight = 600;
    const { meters, seconds } = estimateWalk(straight, speed);

    // The naive figure is what the planner used to quote, and it is optimistic
    // by exactly the circuity factor — which is the bug this guards against.
    const naive = Math.round(straight / speed);
    expect(seconds).toBeGreaterThan(naive);
    expect(seconds).toBe(Math.round(meters / speed));
  });

  it('searches the smaller circle that a walking limit implies', () => {
    // Someone willing to walk 800m can only reach stops about 590m away as the
    // crow flies; searching the full 800m would offer walks they ruled out.
    const radius = searchRadiusFor(800);
    expect(radius).toBeLessThan(800);
    expect(walkDistance(radius)).toBeCloseTo(800, 6);
  });

  it('round-trips a limit through the radius and back', () => {
    for (const limit of [100, 400, 800, 1_200, 5_000]) {
      expect(walkDistance(searchRadiusFor(limit))).toBeCloseTo(limit, 6);
    }
  });
});
