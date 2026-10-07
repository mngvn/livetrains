import { describe, expect, it } from 'vitest';
import { groupDiscRadius, groupMergeRadius, vehiclePlateRadius } from './mapLayers.ts';

describe('marker sizes, as the grouping reads them', () => {
  it('sizes a group disc by count and zoom, as the map draws it', () => {
    expect(groupDiscRadius(3, 8)).toBe(7);
    expect(groupDiscRadius(10, 8)).toBe(8.5);
    expect(groupDiscRadius(150, 11)).toBe(18);
    // Eased between zoom 8 and 11, and held beyond them.
    expect(groupDiscRadius(30, 9.5)).toBeCloseTo((10 + 13.5) / 2, 9);
    expect(groupDiscRadius(3, 5)).toBe(7);
    expect(groupDiscRadius(500, 14)).toBe(18);
  });

  it("sizes half a vehicle's plate along the plate curve", () => {
    expect(vehiclePlateRadius(11)).toBeCloseTo(14 * 0.68, 9);
    expect(vehiclePlateRadius(8)).toBeCloseTo(14 * 0.32, 9);
    expect(vehiclePlateRadius(3)).toBeCloseTo(14 * 0.26, 9);
    expect(vehiclePlateRadius(20)).toBeCloseTo(14 * 1.15, 9);
  });

  it('widens the merge distance from zoom 8 to where grouping stops', () => {
    expect(groupMergeRadius(6)).toBe(14);
    expect(groupMergeRadius(10)).toBe(18);
    expect(groupMergeRadius(12)).toBe(22);
    expect(groupMergeRadius(15)).toBe(22);
  });
});
