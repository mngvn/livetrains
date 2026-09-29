import { describe as group, expect, it } from 'vitest';
import type { Departure } from './api.ts';
import { describe, observationsFrom, summarise, type Observation } from './reliability.ts';

const NOW = 1_800_000_000;

function departure(overrides: Partial<Departure>): Departure {
  return {
    tripId: 't1',
    routeId: '21',
    routeShortName: '21',
    mode: 'bus',
    color: '0053A0',
    textColor: 'FFFFFF',
    headsign: 'Uptown',
    directionId: 0,
    scheduledTime: NOW,
    expectedTime: NOW,
    delaySeconds: 0,
    isRealtime: true,
    ...overrides,
  };
}

function seen(delaySeconds: number, skipped = false, n = 0): Observation {
  return { id: `x${n}`, key: 's|21', tripId: `t${n}`, scheduledTime: NOW, delaySeconds, skipped, at: NOW };
}

group('observationsFrom', () => {
  it('writes down a watched route about to leave, with its delay', () => {
    const rows = observationsFrom('s', [departure({ expectedTime: NOW + 30, scheduledTime: NOW - 90 })], new Set(['21|0']), NOW);
    expect(rows).toEqual([
      expect.objectContaining({ id: `s|t1|${NOW - 90}`, key: 's|21|0', delaySeconds: 120, skipped: false }),
    ]);
  });

  it('ignores other routes, timetable-only times, and departures far off', () => {
    const rows = observationsFrom(
      's',
      [
        departure({ routeId: '6' }),
        departure({ directionId: 1 }),
        departure({ isRealtime: false }),
        departure({ expectedTime: NOW + 20 * 60 }),
        departure({ expectedTime: NOW - 10 * 60 }),
      ],
      new Set(['21|0']),
      NOW,
    );
    expect(rows).toEqual([]);
  });

  it('records a skipped stop even without a prediction', () => {
    const rows = observationsFrom('s', [departure({ isRealtime: false, skipped: true })], new Set(['21|0']), NOW);
    expect(rows[0].skipped).toBe(true);
  });
});

group('summarise', () => {
  it('counts on time as one minute early to five late', () => {
    const summary = summarise([seen(-61, false, 1), seen(-60, false, 2), seen(0, false, 3), seen(300, false, 4), seen(301, false, 5)]);
    expect(summary.count).toBe(5);
    expect(summary.onTimeShare).toBeCloseTo(3 / 5);
    expect(summary.typicalDelaySeconds).toBe(0);
  });

  it('holds back a percentage until there are enough departures', () => {
    const summary = summarise([seen(0), seen(60, false, 1)]);
    expect(summary.onTimeShare).toBeNull();
    expect(describe(summary)).toBe('2 departures seen so far');
  });

  it('counts a skipped stop against on-time, not in the typical delay', () => {
    const summary = summarise([seen(0, false, 1), seen(60, false, 2), seen(120, false, 3), seen(180, false, 4), seen(0, true, 5)]);
    expect(summary.onTimeShare).toBeCloseTo(4 / 5);
    expect(summary.missed).toBe(1);
    expect(summary.typicalDelaySeconds).toBe(90);
    expect(describe(summary)).toBe('On time 8 in 10 · usually 2 min late · 1 didn’t come');
  });

  it('says so when nothing has been seen', () => {
    expect(describe(summarise([]))).toBe('No departures seen yet');
  });
});
