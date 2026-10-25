import { describe, expect, it } from 'vitest';
import { followLines, metresBetween, snapToLines, trackLine, type TrackLine } from './routeTracks.ts';

type Point = [number, number];

// An L: east along 44.97 for about 790 m, then north for about 1.1 km.
const L = trackLine([
  [-93.3, 44.97],
  [-93.29, 44.97],
  [-93.29, 44.98],
])!;

describe('followLines', () => {
  it('turns the corner rather than cutting it', () => {
    const path = followLines([L], [-93.295, 44.97], [-93.29, 44.975])!;
    expect(path).toEqual([
      [-93.295, 44.97],
      [-93.29, 44.97],
      [-93.29, 44.975],
    ]);
  });

  it('starts and ends on the line when the reports are a little off it', () => {
    const path = followLines([L], [-93.295, 44.9702], [-93.2898, 44.975])!;
    expect(path[0][1]).toBeCloseTo(44.97, 9);
    expect(path[path.length - 1][0]).toBeCloseTo(-93.29, 9);
  });

  it('runs back along the line when the report is behind', () => {
    const path = followLines([L], [-93.29, 44.975], [-93.295, 44.97])!;
    expect(path[1]).toEqual([-93.29, 44.97]);
  });

  it('has no way along the line to a report off it', () => {
    expect(followLines([L], [-93.295, 44.97], [-93.295, 44.975])).toBeNull();
  });

  it('keeps to the stretch of an out-and-back line that the vehicle is on', () => {
    // Out east along one street and back the same way.
    const outAndBack = trackLine([
      [-93.3, 44.97],
      [-93.28, 44.97],
      [-93.3, 44.97],
    ])!;
    const path = followLines([outAndBack], [-93.299, 44.97], [-93.297, 44.97])!;
    const length = path.slice(1).reduce((sum, p, i) => sum + metresBetween(path[i], p), 0);
    expect(length).toBeLessThan(200);
  });

  it('prefers the line that runs the way the vehicle is going', () => {
    const east = trackLine([
      [-93.3, 44.97],
      [-93.28, 44.97],
    ])!;
    // The other direction, on a street 30 m to the north.
    const west = trackLine([
      [-93.28, 44.97027],
      [-93.3, 44.97027],
    ])!;
    const path = followLines([west, east], [-93.299, 44.97013], [-93.297, 44.97013])!;
    expect(path.every(([, lat]) => lat === 44.97)).toBe(true);
  });

  it('glides straight rather than going all the way round a long loop', () => {
    // A U whose arms are 200 m apart and 1 km long.
    const u = trackLine([
      [-93.3, 44.97],
      [-93.3, 44.98],
      [-93.2975, 44.98],
      [-93.2975, 44.97],
    ])!;
    expect(followLines([u], [-93.3, 44.9705], [-93.2975, 44.9705])).toBeNull();
  });
});

describe('snapToLines', () => {
  it('finds the nearest place on any line, within reach', () => {
    const other: TrackLine = trackLine([
      [-93.31, 44.96],
      [-93.31, 44.95],
    ])!;
    const snapped = snapToLines([other, L], [-93.2902, 44.976]) as Point;
    expect(snapped[0]).toBeCloseTo(-93.29, 9);
    expect(snapped[1]).toBeCloseTo(44.976, 9);
    expect(snapToLines([other, L], [-93.295, 44.975])).toBeNull();
  });
});
