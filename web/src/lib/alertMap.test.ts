import { describe, expect, it } from 'vitest';
import type { AlertPlace, ServiceAlert } from './api.ts';
import { alertedRouteIds, alertMarkers } from './alertMap.ts';

const NOW = 1_800_000_000;

const places: AlertPlace[] = [
  { stopId: 'A', name: 'Nicollet & 5th', lat: 44.97, lon: -93.27 },
  { stopId: 'B', name: 'Lake St Station', lat: 44.95, lon: -93.24 },
];

function alert(id: string, effect: string, extra: Partial<ServiceAlert> = {}): ServiceAlert {
  return { id, header: id, description: '', effect, routeIds: [], stopIds: [], informed: [], periods: [], ...extra };
}

describe('alertMarkers', () => {
  it('draws one marker per stop, as bad as its worst alert', () => {
    const markers = alertMarkers(
      [
        alert('notice', 'OTHER_EFFECT', { stopIds: ['A'] }),
        alert('closed', 'NO_SERVICE', { stopIds: ['A', 'B'] }),
      ],
      places,
      NOW,
    );
    expect(markers.features).toHaveLength(2);
    const a = markers.features.find((f) => f.properties?.id === 'A')!;
    expect(a.properties).toMatchObject({ rank: 0, count: 2, active: true });
    expect(a.geometry.coordinates).toEqual([-93.27, 44.97]);
  });

  it('lets an alert in force outrank a worse one that is only coming', () => {
    const later = { periods: [{ start: NOW + 3600 }] };
    const markers = alertMarkers(
      [alert('soon', 'NO_SERVICE', { stopIds: ['A'], ...later }), alert('now', 'DETOUR', { stopIds: ['A'] })],
      places,
      NOW,
    );
    expect(markers.features[0].properties).toMatchObject({ rank: 1, active: true });
  });

  it('skips stops the timetable does not know, and agency-wide alerts', () => {
    const markers = alertMarkers([alert('x', 'NO_SERVICE', { stopIds: ['Z'] }), alert('all', 'DETOUR')], places, NOW);
    expect(markers.features).toHaveLength(0);
  });
});

describe('alertedRouteIds', () => {
  it('names lines with a line-wide alert, not a stop or trip one', () => {
    const ids = alertedRouteIds(
      [
        alert('detour', 'DETOUR', { informed: [{ routeId: '21' }] }),
        alert('stop', 'NO_SERVICE', { informed: [{ routeId: '6', stopId: 'A' }] }),
        alert('trip', 'NO_SERVICE', { informed: [{ routeId: '30', tripId: 't1' }] }),
      ],
      NOW,
    );
    expect(ids).toEqual(['21']);
  });
});
