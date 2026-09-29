import { describe, expect, it } from 'vitest';
import type { Departure } from './api.ts';
import { applyFilter, kindOf, NO_FILTER, reconcile, toggle } from './boardFilter.ts';

function departure(routeId: string, mode: Departure['mode']): Departure {
  return {
    tripId: `${routeId}-${mode}`,
    routeId,
    routeShortName: routeId,
    mode,
    color: '000000',
    textColor: 'FFFFFF',
    headsign: 'Somewhere',
    directionId: 0,
    scheduledTime: 0,
    expectedTime: 0,
    delaySeconds: null,
    isRealtime: false,
  };
}

const board = [departure('3', 'bus'), departure('6', 'bus'), departure('BLUE', 'tram'), departure('NS', 'rail')];

describe('board filter', () => {
  it('shows everything when nothing is chosen', () => {
    expect(applyFilter(board, NO_FILTER)).toHaveLength(4);
  });

  it('pins the board to chosen routes', () => {
    expect(applyFilter(board, { routes: ['3'], kinds: [] }).map((d) => d.routeId)).toEqual(['3']);
  });

  it('narrows by kind of vehicle, light rail and commuter rail both counting as trains', () => {
    expect(applyFilter(board, { routes: [], kinds: ['train'] }).map((d) => d.routeId)).toEqual(['BLUE', 'NS']);
    expect(kindOf('tram')).toBe('train');
  });

  it('applies routes and kinds together', () => {
    expect(applyFilter(board, { routes: ['3', 'BLUE'], kinds: ['bus'] }).map((d) => d.routeId)).toEqual(['3']);
  });

  it('toggles values in and out, sorted', () => {
    expect(toggle(['6'], '3')).toEqual(['3', '6']);
    expect(toggle(['3', '6'], '3')).toEqual(['6']);
  });

  it('forgets routes that no longer call at the stop', () => {
    const filter = { routes: ['3', 'GONE'], kinds: [] };
    expect(reconcile(filter, ['3', '6']).routes).toEqual(['3']);
    expect(reconcile({ routes: ['3'], kinds: [] }, ['3', '6'])).toEqual({ routes: ['3'], kinds: [] });
  });
});
