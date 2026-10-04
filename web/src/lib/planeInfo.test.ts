import { describe, expect, it } from 'vitest';
import { compassWord, flightName, planeHeight, planeLabel, planeShape, planeSpeedMph, planeTrend } from './planeInfo.ts';
import { routeFits, type Airport } from './planeLookup.ts';

describe('flightName', () => {
  it('names an airline flight the way the airline does', () => {
    expect(flightName({ id: 'a', callsign: 'DAL1554' })).toEqual({ title: 'Delta 1554', airline: 'Delta' });
  });
  it('names a regional by its brand too', () => {
    expect(flightName({ id: 'a', callsign: 'EDV5350' })).toMatchObject({ title: 'Endeavor Air 5350', brand: 'Delta Connection' });
  });
  it('leaves a private aircraft under its registration', () => {
    expect(flightName({ id: 'a', callsign: 'N1588J', registration: 'N1588J' }).title).toBe('N1588J');
  });
  it('leaves an unknown operator as transmitted', () => {
    expect(flightName({ id: 'a', callsign: 'ZZZ123' }).title).toBe('ZZZ123');
  });
  it('falls back to the tail number, then the transponder', () => {
    expect(planeLabel({ id: 'a1b2c3', registration: 'N12345' })).toBe('N12345');
    expect(planeLabel({ id: '~699144' })).toBe('699144');
  });
});

describe('planeShape', () => {
  it('draws helicopters, light aircraft and everything else', () => {
    expect(planeShape({ category: 'A7' })).toBe('heli');
    expect(planeShape({ category: 'A1', typeCode: 'P28A' })).toBe('light');
    expect(planeShape({ category: 'B1' })).toBe('light');
    expect(planeShape({ category: 'A3', typeCode: 'A321' })).toBe('jet');
  });
  it('guesses from the type when the category is missing', () => {
    expect(planeShape({ typeCode: 'C172' })).toBe('light');
    expect(planeShape({ typeCode: 'EC35' })).toBe('heli');
    expect(planeShape({ typeCode: 'B738' })).toBe('jet');
    expect(planeShape({})).toBe('jet');
  });
});

describe('describing a flight', () => {
  it('says height to the nearest hundred feet', () => {
    expect(planeHeight({ altitude: 3425, onGround: false })).toBe('3,400 ft');
    expect(planeHeight({ altitude: 35000, onGround: false })).toBe('35,000 ft');
    expect(planeHeight({ altitude: 0, onGround: true })).toBe('On the ground');
    expect(planeHeight({ onGround: false })).toBe('');
  });
  it('treats a few hundred feet a minute as level', () => {
    expect(planeTrend({ verticalRate: -1200, onGround: false })).toBe('descending');
    expect(planeTrend({ verticalRate: 64, onGround: false })).toBe('level');
    expect(planeTrend({ verticalRate: 1500, onGround: false })).toBe('climbing');
    expect(planeTrend({ onGround: true, verticalRate: 0 })).toBeNull();
  });
  it('gives speed in mph and direction in words', () => {
    expect(planeSpeedMph({ groundSpeed: 180 })).toBe(207);
    expect(compassWord(301)).toBe('northwest');
    expect(compassWord(359)).toBe('north');
    expect(compassWord(-90)).toBe('west');
  });
});

describe('routeFits', () => {
  const at = (iata: string, lat: number, lon: number): Airport => ({ iata, icao: `K${iata}`, name: iata, city: iata, lat, lon });
  const MSP = at('MSP', 44.882, -93.2218);
  const ATL = at('ATL', 33.6367, -84.4281);
  const LGA = at('LGA', 40.7772, -73.8726);
  const ORD = at('ORD', 41.9786, -87.9048);
  const SEA = at('SEA', 47.449, -122.309);
  const overMinneapolis = { lat: 44.95, lon: -93.25 };

  it('accepts a flight arriving at, or leaving, the airport below it', () => {
    expect(routeFits({ origin: ATL, destination: MSP }, overMinneapolis)).toBe(true);
    expect(routeFits({ origin: MSP, destination: SEA }, overMinneapolis)).toBe(true);
  });
  it('accepts a flight passing over on its way between two other cities', () => {
    // Chicago to Seattle runs close by.
    expect(routeFits({ origin: ORD, destination: SEA }, { lat: 45.3, lon: -94.0 })).toBe(true);
  });
  it("rejects a route listed for a flight number that is plainly flying something else", () => {
    // Seen for real: a Delta 447 over Minneapolis listed as New York to Atlanta.
    expect(routeFits({ origin: LGA, destination: ATL }, overMinneapolis)).toBe(false);
  });
});
