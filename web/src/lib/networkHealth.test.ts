import { describe, expect, it } from 'vitest';
import type { RouteSummary, ServiceAlert, Vehicle } from './api.ts';
import { houseColor, isTrunkLine, lineHealth, networkHealth } from './networkHealth.ts';

const NOW = 1_800_000_000;

function route(id: string, mode: RouteSummary['mode'] = 'bus', color = '0053A0'): RouteSummary {
  return { id, shortName: id, longName: `${id} line`, mode, color, textColor: 'FFFFFF' };
}

function vehicle(routeId: string, delaySeconds?: number, age = 10): Vehicle {
  return {
    id: `${routeId}-${Math.random()}`,
    routeId,
    mode: 'bus',
    color: '0053A0',
    lat: 44.97,
    lon: -93.27,
    timestamp: NOW - age,
    delaySeconds,
  } as Vehicle;
}

function alert(routeId: string, effect: string, extra: Partial<ServiceAlert> = {}): ServiceAlert {
  return {
    id: `${routeId}-${effect}`,
    header: `${effect} on ${routeId}`,
    description: '',
    effect,
    routeIds: [routeId],
    stopIds: [],
    informed: [{ routeId }],
    periods: [],
    ...extra,
  };
}

describe('lineHealth', () => {
  it('calls a line running to time good service', () => {
    const health = lineHealth(route('21'), [vehicle('21', 30), vehicle('21', 90), vehicle('21')], []);
    expect(health.state).toBe('good');
    expect(health.reason).toBe('3 buses running, on time');
  });

  it('does not let one straggler give a line a bad name', () => {
    const health = lineHealth(route('21'), [vehicle('21', 400), vehicle('21', 30), vehicle('21', 60)], []);
    expect(health.state).toBe('good');
    expect(health.reason).toBe('1 of 3 buses over 5 min late');
  });

  it('calls a line minor delays when a good share of its vehicles are well behind', () => {
    const health = lineHealth(
      route('21'),
      [vehicle('21', 400), vehicle('21', 360), vehicle('21', 30), vehicle('21', 60), vehicle('21', 0)],
      [],
    );
    expect(health.state).toBe('minor');
    expect(health.reason).toBe('2 of 5 buses over 5 min late');
  });

  it('calls a line severe delays when most of its vehicles are well behind', () => {
    const health = lineHealth(
      route('BLUE', 'tram'),
      [vehicle('BLUE', 700), vehicle('BLUE', 400), vehicle('BLUE', 500), vehicle('BLUE', 0)],
      [],
    );
    expect(health.state).toBe('severe');
    expect(health.reason).toBe('3 of 4 trains over 5 min late');
  });

  it('never calls a line severe on the strength of one bus', () => {
    expect(lineHealth(route('215'), [vehicle('215', 900)], []).state).toBe('minor');
  });

  it('reads a cancelled trip as trips cancelled, not the line suspended', () => {
    const notice = alert('30', 'NO_SERVICE', {
      header: 'Route 30 trip departing Westgate Station - Gate B at 1:04 PM and seven other trips canceled today',
    });
    const health = lineHealth(route('30'), [vehicle('30', 0)], [notice]);
    expect(health.state).toBe('disrupted');
    expect(health.label).toBe('Trips cancelled');
  });

  it('lets an alert make a line worse but never better', () => {
    const detour = lineHealth(route('21'), [vehicle('21', 0)], [alert('21', 'DETOUR')]);
    expect(detour.state).toBe('disrupted');
    expect(detour.label).toBe('Detour');

    const suspended = lineHealth(route('21'), [], [alert('21', 'NO_SERVICE')]);
    expect(suspended.state).toBe('suspended');

    // A severe line with a mere detour notice stays severe.
    const severe = lineHealth(route('21'), [vehicle('21', 900), vehicle('21', 800)], [alert('21', 'DETOUR')]);
    expect(severe.state).toBe('severe');
  });

  it('does not let an elevator notice mark the whole line disrupted', () => {
    const health = lineHealth(route('BLUE', 'tram'), [vehicle('BLUE', 0)], [alert('BLUE', 'ACCESSIBILITY_ISSUE')]);
    expect(health.state).toBe('good');
  });
});

describe('networkHealth', () => {
  it('sorts the worst lines first and counts each state', () => {
    const routes = [route('5'), route('21'), route('BLUE', 'tram'), route('94')];
    const health = networkHealth(
      routes,
      [vehicle('5', 0), vehicle('21', 900), vehicle('21', 700), vehicle('21', 650), vehicle('BLUE', 30)],
      [alert('5', 'DETOUR')],
      NOW,
    );
    expect(health.lines.map((l) => [l.route.id, l.state])).toEqual([
      ['21', 'severe'],
      ['5', 'disrupted'],
      ['BLUE', 'good'],
      ['94', 'quiet'],
    ]);
    expect(health.counts.quiet).toBe(1);
    expect(health.running).toBe(3);
    expect(health.onTimeShare).toBe(0.4);
  });

  it('ignores positions too old to be live', () => {
    const health = networkHealth([route('21')], [vehicle('21', 0, 600)], [], NOW);
    expect(health.vehicles).toBe(0);
    expect(health.lines[0].state).toBe('quiet');
  });

  it('ignores alerts that are not in force', () => {
    const later = alert('21', 'NO_SERVICE', { periods: [{ start: NOW + 3600, end: NOW + 7200 }] });
    const health = networkHealth([route('21')], [vehicle('21', 0)], [later], NOW);
    expect(health.lines[0].state).toBe('good');
  });
});

describe('trunk lines', () => {
  it('treats rail and anything not in the house colour as a named line', () => {
    const routes = ['2', '3', '4', '6'].map((id) => route(id)).concat(route('A', 'bus', 'ED1B2E'), route('BLUE', 'tram', '0053A0'));
    const house = houseColor(routes);
    expect(house).toBe('0053A0');
    expect(isTrunkLine(routes[0], house)).toBe(false);
    expect(isTrunkLine(routes[4], house)).toBe(true);
    expect(isTrunkLine(routes[5], house)).toBe(true);
  });
});
