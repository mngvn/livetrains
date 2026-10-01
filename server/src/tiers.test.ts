import { describe, expect, it } from 'vitest';
import { createMockStore } from './mock/index.js';
import { lineTiers } from './tiers.js';
import { majorStops, stopImportance, stopWithRoutes } from './departures.js';

describe('line tiers', () => {
  const store = createMockStore();
  const tierOf = (id: string) => lineTiers(store)[store.routes.findIndex((r) => r.id === id)];

  it('puts light rail in the rail tier', () => {
    expect(tierOf('BLUE')).toBe('rail');
    expect(tierOf('GREEN')).toBe('rail');
  });

  it('counts every bus as branded when no colour is a house style', () => {
    // The demo feed's few buses all have their own colours.
    expect(tierOf('ROUTE21')).toBe('branded');
    expect(tierOf('ROUTEA')).toBe('branded');
  });

  it('puts buses wearing the house colour in the bus tier', () => {
    const big = createMockStore();
    const house = '0053A0';
    // Recolour enough buses to make one colour the house style.
    for (const route of big.routes.filter((r) => r.mode === 'bus')) route.color = house;
    for (let i = 0; i < 4; i++) big.routes.push({ ...big.routes.find((r) => r.mode === 'bus')!, id: `X${i}` });
    const tiers = lineTiers(big);
    big.routes.forEach((route, index) => {
      if (route.mode === 'bus') expect(tiers[index]).toBe('bus');
    });
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

  it('gives a station the routes of its platforms', () => {
    const station = store.stopIndexById.get('NICOLLET-STN')!;
    const routes = stopWithRoutes(store, station).routes!.map((r) => r.id);
    expect(routes).toEqual(expect.arrayContaining(['BLUE', 'GREEN']));
  });
});
