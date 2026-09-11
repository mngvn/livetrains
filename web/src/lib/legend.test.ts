import { describe, expect, it } from 'vitest';
import type { Mode, RouteSummary } from './api.ts';
import { splitBrandedLines } from './legend.ts';

function route(id: string, shortName: string, color: string, mode: Mode = 'bus'): RouteSummary {
  return { id, shortName, longName: `${shortName} Line`, mode, color, textColor: 'FFFFFF' };
}

/**
 * A route list shaped like Metro Transit's: a handful of branded lines and a
 * long tail of local buses that all share one colour. This is the case the
 * legend exists for, and the one the synthetic demo feed is too small to
 * exercise.
 */
function metroTransitShaped(): RouteSummary[] {
  const localBus = '0053A0';
  return [
    route('901', 'Blue', '003DA5', 'tram'),
    route('902', 'Green', '00A94F', 'tram'),
    route('888', 'Northstar', 'FFB81C', 'rail'),
    route('921', 'A Line', 'C8102E'),
    route('923', 'C Line', '7A3E98'),
    route('924', 'D Line', '00A5B5'),
    // The long tail: 120 ordinary local routes sharing the house colour.
    ...Array.from({ length: 120 }, (_, i) => route(`${i + 2}`, String(i + 2), localBus)),
  ];
}

describe('splitBrandedLines', () => {
  it('names the branded lines and collapses the local buses', () => {
    const { branded, genericColor, genericCount } = splitBrandedLines(metroTransitShaped());

    expect(genericColor).toBe('0053A0');
    expect(genericCount).toBe(120);

    const named = branded.map((r) => r.shortName);
    expect(named).toContain('Blue');
    expect(named).toContain('Green');
    expect(named).toContain('A Line');
    // No ordinary local bus should be named individually.
    expect(named).not.toContain('14');
  });

  it('puts rail ahead of buses, so the lines people navigate by come first', () => {
    const { branded } = splitBrandedLines(metroTransitShaped());
    const firstBus = branded.findIndex((r) => r.mode === 'bus');
    const lastRail = branded.map((r) => r.mode).lastIndexOf('tram');
    expect(lastRail).toBeLessThan(firstBus);
    expect(branded[0].mode === 'rail' || branded[0].mode === 'tram').toBe(true);
  });

  it('caps the list so the legend stays a legend', () => {
    const many = [
      ...Array.from({ length: 40 }, (_, i) => route(`x${i}`, `X${i}`, `AA00${(i % 10).toString()}0`)),
      ...Array.from({ length: 60 }, (_, i) => route(`b${i}`, `${i}`, '0053A0')),
    ];
    expect(splitBrandedLines(many).branded.length).toBeLessThanOrEqual(10);
  });

  it('names everything when a small feed has no generic colour', () => {
    // The demo feed's shape: five routes, most distinctly coloured.
    const small = [
      route('BLUE', 'Blue', '003DA5', 'tram'),
      route('GREEN', 'Green', '00A94F', 'tram'),
      route('R5', '5', '0B5FA5'),
      route('R21', '21', '0B5FA5'),
      route('A', 'A Line', 'C8102E'),
    ];
    const { branded, genericColor } = splitBrandedLines(small);
    // Only two routes share a colour, which is a coincidence, not a house style.
    expect(genericColor).toBeNull();
    expect(branded).toHaveLength(5);
  });

  it('handles an empty feed', () => {
    expect(splitBrandedLines([])).toEqual({ branded: [], genericColor: null, genericCount: 0 });
  });
});
