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

describe('groupVehicles with a footprint', () => {
  const footprint = { disc: (count: number) => (count >= 10 ? 12 : 8), plate: 4 };

  it('merges groups whose discs would overlap', () => {
    // Two clusters whose centres are 14 px apart: each groups on its own,
    // but their 8 px discs would overlap.
    const points = [at('a', 0, 0), at('b', 2, 0), at('c', 4, 0), at('d', 14, 0), at('e', 16, 0), at('f', 18, 0)];
    expect(groupVehicles(points, 6).groups).toHaveLength(2);
    const { groups, grouped } = groupVehicles(points, 6, null, footprint);
    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(6);
    expect(grouped.size).toBe(6);
  });

  it('folds a lone vehicle whose plate would land on a disc into it', () => {
    const points = [at('a', 0, 0), at('b', 2, 0), at('c', 4, 0), at('lone', 13, 0), at('far', 60, 0)];
    const { groups, grouped } = groupVehicles(points, 6, null, footprint);
    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(4);
    expect(grouped.has('lone')).toBe(true);
    expect(grouped.has('far')).toBe(false);
  });

  it('leaves no two discs overlapping and no plate on a disc, however dense', () => {
    const points: GroupInput[] = [];
    for (let i = 0; i < 400; i++) {
      // A deterministic scatter, densest in the middle.
      const angle = i * 2.399963;
      const r = Math.sqrt(i) * 6;
      points.push(at(`v${i}`, 200 + r * Math.cos(angle), 200 + r * Math.sin(angle), i % 4 === 0));
    }
    const { groups, grouped } = groupVehicles(points, 14, null, footprint);
    const centre = (g: { lon: number; lat: number }) => ({ x: g.lon * 100, y: g.lat * 100 });
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const a = centre(groups[i]);
        const b = centre(groups[j]);
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(
          footprint.disc(groups[i].count) + footprint.disc(groups[j].count) - 1e-9,
        );
      }
    }
    for (const p of points) {
      if (grouped.has(p.id)) continue;
      for (const g of groups) {
        const c = centre(g);
        expect(Math.hypot(p.x - c.x, p.y - c.y)).toBeGreaterThanOrEqual(footprint.disc(g.count) + footprint.plate - 1e-9);
      }
    }
    expect(groups.reduce((n, g) => n + g.count, 0)).toBe(grouped.size);
    expect(groups.reduce((n, g) => n + g.rail, 0)).toBe([...grouped].filter((id) => Number(id.slice(1)) % 4 === 0).length);
  });
});
