import { describe, expect, it } from 'vitest';
import { isDarkOutside, solarElevation } from './sun.ts';

/** Minneapolis. */
const LAT = 44.98;
const LON = -93.27;

describe('solarElevation', () => {
  it('puts the summer sun high over Minneapolis at solar noon', () => {
    // Solar noon in late June is about 13:15 CDT, 18:15 UTC; the sun is ~68° up.
    const elevation = solarElevation(new Date('2026-06-21T18:15:00Z'), LAT, LON);
    expect(elevation).toBeGreaterThan(66);
    expect(elevation).toBeLessThan(70);
  });

  it('puts the winter noon sun low', () => {
    // ~21.6° at solar noon on the winter solstice.
    const elevation = solarElevation(new Date('2026-12-21T18:05:00Z'), LAT, LON);
    expect(elevation).toBeGreaterThan(19);
    expect(elevation).toBeLessThan(24);
  });
});

describe('isDarkOutside', () => {
  it('is light at lunchtime and dark at midnight', () => {
    expect(isDarkOutside(new Date('2026-10-01T17:00:00Z'), LAT, LON)).toBe(false);
    expect(isDarkOutside(new Date('2026-10-02T05:00:00Z'), LAT, LON)).toBe(true);
  });

  it('turns dark shortly after sunset, not at it', () => {
    // Sunset in Minneapolis on 1 October 2026 is about 18:55 CDT (23:55 UTC).
    expect(isDarkOutside(new Date('2026-10-01T23:50:00Z'), LAT, LON)).toBe(false);
    expect(isDarkOutside(new Date('2026-10-02T00:35:00Z'), LAT, LON)).toBe(true);
  });
});
