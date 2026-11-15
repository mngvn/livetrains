import { describe, expect, it } from 'vitest';
import { lateCounts, lateLabel, lateLevel } from './lateMarks.ts';

describe('lateLevel', () => {
  it('marks five minutes behind as late and ten as very late', () => {
    expect(lateLevel(4 * 60 + 59)).toBe(0);
    expect(lateLevel(5 * 60)).toBe(1);
    expect(lateLevel(9 * 60 + 59)).toBe(1);
    expect(lateLevel(10 * 60)).toBe(2);
  });

  it('marks nothing on a vehicle that is early, or whose delay is not known', () => {
    expect(lateLevel(-240)).toBe(0);
    expect(lateLevel(undefined)).toBe(0);
  });
});

describe('lateLabel', () => {
  it('says how late in whole minutes', () => {
    expect(lateLabel(5 * 60)).toBe('+5 min');
    expect(lateLabel(11 * 60 + 40)).toBe('+12 min');
  });
});

describe('lateCounts', () => {
  it('counts the late, and the very late among them', () => {
    const fleet = [{ delaySeconds: 0 }, { delaySeconds: 360 }, { delaySeconds: 900 }, {}, { delaySeconds: 700, stale: true }];
    expect(lateCounts(fleet)).toEqual({ late: 2, veryLate: 1 });
  });
});
