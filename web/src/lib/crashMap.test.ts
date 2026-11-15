import { describe, expect, it } from 'vitest';
import type { RouteSummary, ServiceAlert } from './api.ts';
import { activeCrashes, crashMarkers, crashSummary } from './crashMap.ts';

const route = (id: string, shortName: string, longName: string): RouteSummary =>
  ({ id, shortName, longName, mode: 'bus', color: '0B5FA5', textColor: 'FFFFFF' }) as RouteSummary;
const ROUTES = new Map(
  [route('925', 'E', 'METRO E Line'), route('901', 'Blue', 'METRO Blue Line'), route('21', '21', 'Lake St - Selby Av')].map(
    (r) => [r.id, r],
  ),
);
const alert = (overrides: Partial<ServiceAlert>): ServiceAlert => ({
  id: 'a',
  header: 'Southbound E Line trip canceled from 4th St & 15th Ave today due to collision',
  description: '',
  routeIds: ['925'],
  stopIds: [],
  informed: [],
  periods: [],
  ...overrides,
});
const PLACE = { stopId: '16112', name: '4th St & 15th Ave Station', lat: 44.98, lon: -93.2347 };

describe('activeCrashes', () => {
  it('joins each report to its alert and names its lines as riders do', () => {
    const [crash] = activeCrashes([alert({})], [{ alertId: 'a', place: PLACE }], ROUTES, 1000);
    expect(crash.lines).toEqual(['E Line']);
    expect(crashSummary(crash)).toBe('Crash reported on the E Line near 4th St & 15th Ave Station');
  });

  it('leaves out a crash whose alert is over, or not yet in force', () => {
    const over = alert({ periods: [{ start: 100, end: 900 }] });
    const coming = alert({ id: 'b', periods: [{ start: 2000 }] });
    expect(activeCrashes([over, coming], [{ alertId: 'a' }, { alertId: 'b' }], ROUTES, 1000)).toEqual([]);
    expect(activeCrashes([over], [{ alertId: 'a' }], ROUTES, 500)).toHaveLength(1);
  });

  it('ignores a report whose alert has gone from the feed', () => {
    expect(activeCrashes([], [{ alertId: 'gone', place: PLACE }], ROUTES, 1000)).toEqual([]);
  });
});

describe('crashSummary', () => {
  const summary = (overrides: Partial<ServiceAlert>, place?: typeof PLACE) =>
    crashSummary(activeCrashes([alert(overrides)], [{ alertId: 'a', place }], ROUTES, 1000)[0]);

  it('says what it knows and no more', () => {
    expect(summary({ routeIds: ['21'] })).toBe('Crash reported on Route 21');
    expect(summary({ routeIds: [] }, PLACE)).toBe('Crash reported near 4th St & 15th Ave Station');
    expect(summary({ routeIds: [] })).toBe('Crash reported');
    expect(summary({ routeIds: ['901', '925', '21'] })).toBe('Crash reported on the Blue Line and E Line and 1 more');
  });
});

describe('crashMarkers', () => {
  it('draws one mark where several alerts report the same crash, and none for a crash with no place', () => {
    const crashes = activeCrashes(
      [alert({}), alert({ id: 'b' }), alert({ id: 'c', routeIds: ['21'] })],
      [{ alertId: 'a', place: PLACE }, { alertId: 'b', place: PLACE }, { alertId: 'c' }],
      ROUTES,
      1000,
    );
    const { features } = crashMarkers(crashes);
    expect(features).toHaveLength(1);
    expect(features[0].geometry.coordinates).toEqual([PLACE.lon, PLACE.lat]);
    expect(features[0].properties).toMatchObject({ id: '16112', name: '4th St & 15th Ave Station', lines: 'E Line' });
  });
});
