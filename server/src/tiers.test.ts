import { describe, expect, it } from 'vitest';
import { createMockStore } from './mock/index.js';
import { lineTiers } from './tiers.js';
import { lineTier } from './shared/lines.js';
import { majorStops, stopImportance, stopWithRoutes } from './departures.js';

describe('line tiers', () => {
  const store = createMockStore();
  const tierOf = (id: string) => lineTiers(store)[store.routes.findIndex((r) => r.id === id)];

  it('puts light rail in the rail tier', () => {
    expect(tierOf('BLUE')).toBe('rail');
    expect(tierOf('GREEN')).toBe('rail');
  });

  it('treats a bus named as a line as branded, and ordinary routes as buses', () => {
    expect(tierOf('ROUTEA')).toBe('branded');
    expect(tierOf('ROUTE21')).toBe('bus');
    expect(tierOf('ROUTE5')).toBe('bus');
  });
});

describe('lineTier, by name', () => {
  const bus = (shortName: string, longName = '') => lineTier({ mode: 'bus', shortName, longName });

  it('knows the METRO lines from the ordinary routes', () => {
    expect(bus('METRO C Line', 'METRO C Line')).toBe('branded');
    expect(bus('METRO Orange Line', 'METRO Orange Line')).toBe('branded');
    expect(bus('21', '')).toBe('bus');
    // Expresses and suburban routes have colours of their own but are not lines.
    expect(bus('578', '')).toBe('bus');
    expect(bus('600', '')).toBe('bus');
  });

  it('does not mistake a bus standing in for a line for the line', () => {
    expect(bus('Green Line Bus', 'Green Line Bus')).toBe('bus');
    expect(lineTier({ mode: 'tram', shortName: 'Airport Shuttle' })).toBe('rail');
  });
});

describe('major stops', () => {
  const store = createMockStore();

  it('folds platforms into their station', () => {
    const ids = majorStops(store).map((s) => s.id);
    expect(ids).toContain('NICOLLET-STN');
    expect(ids).not.toContain('BL03');
  });

  it('marks a stop where rail lines meet as an interchange', () => {
    const govPlaza = store.stopIndexById.get('BL04')!;
    expect(stopImportance(store, govPlaza).interchange).toBe(true);
    expect(stopWithRoutes(store, govPlaza).interchange).toBe(true);
  });

  it('shows stations and line stops from the widest view, and ordinary stops only closer in', () => {
    const govPlaza = store.stopIndexById.get('BL04')!;
    expect(stopImportance(store, govPlaza).onLine).toBe(true);

    // A stop served only by ordinary routes is not on a line, however busy.
    const busOnly = store.stops.findIndex((_, i) => {
      const routes = stopWithRoutes(store, i).routes ?? [];
      return routes.length > 0 && routes.every((r) => r.id === 'ROUTE21' || r.id === 'ROUTE5');
    });
    expect(busOnly).toBeGreaterThanOrEqual(0);
    expect(stopImportance(store, busOnly).onLine).toBe(false);
  });

  it('gives a station the routes of its platforms', () => {
    const station = store.stopIndexById.get('NICOLLET-STN')!;
    const routes = stopWithRoutes(store, station).routes!.map((r) => r.id);
    expect(routes).toEqual(expect.arrayContaining(['BLUE', 'GREEN']));
  });
});
