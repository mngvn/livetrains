import { describe, expect, it } from 'vitest';
import { projectOntoLine, splitLineAt } from './geometry.ts';

// An L: east along 44.98, then north.
const L: [number, number][] = [
  [-93.28, 44.98],
  [-93.26, 44.98],
  [-93.26, 45.0],
];

describe('projectOntoLine', () => {
  it('finds the right segment and position along it', () => {
    const hit = projectOntoLine(L, [-93.27, 44.981])!;
    expect(hit.segment).toBe(0);
    expect(hit.t).toBeCloseTo(0.5, 3);
    expect(hit.point[1]).toBeCloseTo(44.98, 6);
  });

  it('clamps to the ends rather than running off them', () => {
    expect(projectOntoLine(L, [-93.3, 44.98])!.point).toEqual([-93.28, 44.98]);
    expect(projectOntoLine(L, [-93.26, 45.1])!.point).toEqual([-93.26, 45.0]);
  });

  it('copes with a single point and with nothing', () => {
    expect(projectOntoLine([[1, 2]], [3, 4])!.point).toEqual([1, 2]);
    expect(projectOntoLine([], [3, 4])).toBeNull();
  });

  it('accounts for longitude degrees being shorter than latitude degrees', () => {
    // A point equidistant in raw degrees from the two legs, but nearer the
    // east-west leg in metres once longitude is scaled down at 45°N.
    const hit = projectOntoLine(L, [-93.265, 44.985])!;
    expect(hit.segment).toBe(1);
  });
});

describe('splitLineAt', () => {
  it('cuts at the vehicle, with the cut shared by both halves', () => {
    const { behind, ahead } = splitLineAt(L, [-93.26, 44.99]);
    expect(behind[behind.length - 1]).toEqual(ahead[0]);
    expect(behind[0]).toEqual(L[0]);
    expect(ahead[ahead.length - 1]).toEqual(L[2]);
    // Behind includes the corner; ahead does not.
    expect(behind).toContainEqual(L[1]);
    expect(ahead).not.toContainEqual(L[1]);
  });

  it('puts everything ahead at the start of the trip', () => {
    const { behind, ahead } = splitLineAt(L, [-93.28, 44.98]);
    expect(behind).toHaveLength(2);
    expect(ahead).toHaveLength(3);
  });
});
