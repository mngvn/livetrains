import { describe, expect, it } from 'vitest';
import { groupVehicles, type GroupInput } from './grouping.ts';

function at(id: string, x: number, y: number, rail = false): GroupInput {
  return { id, x, y, lon: x / 100, lat: y / 100, rail };
}

describe('groupVehicles', () => {
  it('groups three or more vehicles close together, and leaves pairs alone', () => {
    const { groups, grouped } = groupVehicles(
      [at('a', 0, 0), at('b', 10, 5), at('c', 20, 0), at('d', 500, 500), at('e', 510, 500)],
      40,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(3);
    expect([...grouped].sort()).toEqual(['a', 'b', 'c']);
  });

  it('places the group at the average of its members and counts its trains', () => {
    const { groups } = groupVehicles([at('a', 0, 0, true), at('b', 20, 0), at('c', 40, 0, true)], 50);
    expect(groups[0]).toMatchObject({ lat: 0, count: 3, rail: 2 });
    expect(groups[0].lon).toBeCloseTo(0.2, 9);
  });

  it('never folds the selected vehicle into a group', () => {
    const { groups, grouped } = groupVehicles([at('a', 0, 0), at('b', 5, 0), at('c', 10, 0)], 40, 'b');
    expect(groups).toHaveLength(0);
    expect(grouped.has('b')).toBe(false);
  });

  it('groups the same way whatever order the vehicles arrive in', () => {
    const points = [at('a', 0, 0), at('b', 30, 0), at('c', 60, 0), at('d', 90, 0), at('e', 120, 0)];
    const forward = groupVehicles(points, 40);
    const backward = groupVehicles([...points].reverse(), 40);
    expect([...forward.grouped].sort()).toEqual([...backward.grouped].sort());
    expect(forward.groups.map((g) => g.count)).toEqual(backward.groups.map((g) => g.count));
  });
});
