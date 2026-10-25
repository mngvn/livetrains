import { describe, expect, it } from 'vitest';
import { distanceToLines, pickRoute } from './routeHover.ts';

describe('pickRoute', () => {
  it('means nothing when the pointer is on no line', () => {
    expect(pickRoute([])).toBeNull();
  });

  it('prefers a train to a bus on the same street, then the nearer line', () => {
    const hover = pickRoute([
      { routeId: '5', tier: 'bus', distance: 0.5 },
      { routeId: 'Blue', tier: 'rail', distance: 4 },
      { routeId: '14', tier: 'bus', distance: 2 },
      { routeId: 'D', tier: 'branded', distance: 3 },
    ]);
    expect(hover).toEqual({ routeId: 'Blue', others: ['D', '5', '14'] });
  });

  it('counts a route drawn in both directions once, by its nearer line', () => {
    const hover = pickRoute([
      { routeId: '5', tier: 'bus', distance: 5 },
      { routeId: '14', tier: 'bus', distance: 2 },
      { routeId: '5', tier: 'bus', distance: 1 },
    ]);
    expect(hover).toEqual({ routeId: '5', others: ['14'] });
  });
});

describe('distanceToLines', () => {
  it('measures to the nearest segment of the nearest line', () => {
    const lines: [number, number][][] = [
      [
        [0, 0],
        [10, 0],
      ],
      [
        [0, 20],
        [10, 20],
        [10, 30],
      ],
    ];
    expect(distanceToLines(lines, [5, 3])).toBeCloseTo(3);
    expect(distanceToLines(lines, [13, 25])).toBeCloseTo(3);
    expect(distanceToLines(lines, [-4, 0])).toBeCloseTo(4);
  });
});
