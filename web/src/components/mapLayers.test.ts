import { describe, expect, it } from 'vitest';
import { groupDiscRadius, groupLateOffset, groupMergeRadius, vehiclePlateRadius } from './mapLayers.ts';

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

  it("puts a group's late count on the shoulder of its disc, whatever the disc's size", () => {
    for (const [count, zoom, textSize] of [[3, 8, 6], [40, 9.5, 7.5], [200, 11, 9]] as const) {
      const [dx, dy] = groupLateOffset(count, zoom);
      // Up and to the right, in ems of the count's text: just past the rim.
      expect(dy).toBe(-dx);
      expect(Math.hypot(dx, dy) * textSize).toBeCloseTo(groupDiscRadius(count, zoom) * 0.88 * Math.SQRT2, 9);
    }
  });

  it('widens the merge distance from zoom 8 to where grouping stops', () => {
    expect(groupMergeRadius(6)).toBe(14);
    expect(groupMergeRadius(10)).toBe(18);
    expect(groupMergeRadius(12)).toBe(22);
    expect(groupMergeRadius(15)).toBe(22);
  });
});
