import { describe, expect, it } from 'vitest';
import { deadReckon, fillPlaneUrl, planeArea, readPlanes } from './planes.js';
import { mockPlanes } from '../mock/planes.js';

/** Trimmed from a real adsb.lol response over the Twin Cities. */
const ADSB_LOL = {
  ac: [
    {
      hex: 'a095aa', type: 'adsb_icao', flight: 'EDV5350 ', r: 'N137EV', t: 'CRJ9', alt_baro: 1050, alt_geom: 1250,
      gs: 132.9, track: 301.78, baro_rate: -768, squawk: '7325', emergency: 'none', category: 'A3',
      lat: 44.869002, lon: -93.165804, seen_pos: 0.192, seen: 0.1,
    },
    {
      hex: '~699144', type: 'adsb_other', alt_baro: 1400, gs: 77.9, track: 282.61, baro_rate: -64,
      emergency: 'none', lat: 44.610764, lon: -93.074537, seen_pos: 1.949, seen: 1.9,
    },
    // On the ground at the airport, with no track.
    { hex: 'a091d5', flight: 'DAL2007 ', alt_baro: 'ground', gs: 0, lat: 44.883, lon: -93.2145, seen_pos: 3 },
    // An airport service truck: ADS-B category C, not an aircraft.
    { hex: 'ade001', flight: 'OPS12', category: 'C2', alt_baro: 'ground', lat: 44.88, lon: -93.21, seen_pos: 1 },
    // Heard, but not placed for over a minute.
    { hex: 'a8befa', flight: 'N6627F  ', alt_baro: 2700, lat: 45.35, lon: -92.87, seen_pos: 75 },
    // No position at all.
    { hex: 'a12345', flight: 'SKW3811', alt_baro: 9000, seen: 0.5 },
  ],
  now: 1791140619001,
  total: 6,
};

describe('readPlanes', () => {
  it('reads adsb.lol, whose clock is in milliseconds', () => {
    const { planes, now } = readPlanes(ADSB_LOL);
    expect(now).toBeCloseTo(1791140619.001, 3);
    expect(planes.map((p) => p.id)).toEqual(['a095aa', '~699144', 'a091d5']);

    const edv = planes[0];
    expect(edv).toMatchObject({
      callsign: 'EDV5350',
      registration: 'N137EV',
      typeCode: 'CRJ9',
      altitude: 1050,
      onGround: false,
      groundSpeed: 132.9,
      track: 301.78,
      verticalRate: -768,
      category: 'A3',
    });
    // "none" is not an emergency.
    expect(edv.emergency).toBeUndefined();
    expect(edv.positionAt).toBeCloseTo(now - 0.192, 3);
  });

  it('reads the ground as altitude zero', () => {
    const ground = readPlanes(ADSB_LOL).planes.find((p) => p.id === 'a091d5');
    expect(ground).toMatchObject({ onGround: true, altitude: 0, groundSpeed: 0 });
    expect(ground?.track).toBeUndefined();
  });

  it('reads adsb.fi, whose list is "aircraft" and clock is in seconds', () => {
    const { planes, now } = readPlanes({
      aircraft: [{ ...ADSB_LOL.ac[0], desc: 'BOMBARDIER Regional Jet CRJ-900', ownOp: 'DELTA AIR LINES INC' }],
      now: 1791140620.001,
      resultCount: 1,
    });
    expect(now).toBeCloseTo(1791140620.001, 3);
    expect(planes[0]).toMatchObject({ typeName: 'BOMBARDIER Regional Jet CRJ-900', owner: 'DELTA AIR LINES INC' });
  });

  it("passes the app's own relay through as it is", () => {
    const relayed = readPlanes({ planes: readPlanes(ADSB_LOL).planes, now: 100, source: 'adsb.lol' });
    expect(relayed.planes).toHaveLength(3);
    expect(relayed.source).toBe('adsb.lol');
  });

  it('survives nonsense', () => {
    expect(readPlanes(null).planes).toEqual([]);
    expect(readPlanes('<html>').planes).toEqual([]);
    expect(readPlanes({ ac: [null, 3, { hex: 'x', lat: 'north' }] }).planes).toEqual([]);
  });
});

describe('planeArea', () => {
  it("covers the Twin Cities' box with a margin", () => {
    const area = planeArea([-93.6, 44.72, -92.85, 45.18]);
    expect(area.lat).toBeCloseTo(44.95, 2);
    expect(area.lon).toBeCloseTo(-93.225, 3);
    // The half-diagonal is about 21nm; the margin adds 15.
    expect(area.radiusNm).toBeGreaterThanOrEqual(35);
    expect(area.radiusNm).toBeLessThanOrEqual(38);
  });

  it('never asks for more than a metro needs', () => {
    expect(planeArea([-180, -85, 180, 85]).radiusNm).toBe(100);
  });
});

describe('fillPlaneUrl', () => {
  const area = { lat: 44.95, lon: -93.225, radiusNm: 37 };
  it('fills a plain template', () => {
    expect(fillPlaneUrl('https://api.adsb.lol/v2/point/{lat}/{lon}/{radius}', area)).toBe(
      'https://api.adsb.lol/v2/point/44.95/-93.225/37',
    );
  });
  it('fills one nested inside another URL', () => {
    expect(fillPlaneUrl('https://relay.example/?url=https%3A%2F%2Fx%2F%7Blat%7D%2F%7Blon%7D%2F%7Bradius%7D', area)).toBe(
      'https://relay.example/?url=https%3A%2F%2Fx%2F44.95%2F-93.225%2F37',
    );
  });
  it('leaves a URL without placeholders alone', () => {
    expect(fillPlaneUrl('https://api.example.com/api/planes', area)).toBe('https://api.example.com/api/planes');
  });
});

describe('deadReckon', () => {
  it('carries a plane north by a minute of latitude per nautical mile', () => {
    // 360 knots for 10 seconds is one nautical mile.
    const { lat, lon } = deadReckon(44.9, -93.2, 0, 360, 10);
    expect(lat - 44.9).toBeCloseTo(1 / 60, 4);
    expect(lon).toBeCloseTo(-93.2, 9);
  });
  it('carries a plane east by more degrees of longitude than of latitude', () => {
    const { lat, lon } = deadReckon(44.9, -93.2, 90, 360, 10);
    expect(lat).toBeCloseTo(44.9, 9);
    expect(lon + 93.2).toBeCloseTo(1 / 60 / Math.cos((44.9 * Math.PI) / 180), 4);
  });
});

describe('mockPlanes', () => {
  it('fills the demo sky with plausible aircraft near the airport', () => {
    const { planes, source } = mockPlanes(1_791_140_000);
    expect(source).toBe('demo');
    expect(planes.length).toBeGreaterThanOrEqual(3);
    for (const plane of planes) {
      expect(plane.lat).toBeGreaterThan(44);
      expect(plane.lat).toBeLessThan(46);
      expect(plane.lon).toBeGreaterThan(-95);
      expect(plane.lon).toBeLessThan(-92);
      expect(plane.altitude).toBeGreaterThanOrEqual(0);
      expect(plane.altitude).toBeLessThanOrEqual(36000);
    }
  });

  it('moves each aircraft the way it says it is going', () => {
    const t = 1_791_140_000;
    const before = new Map(mockPlanes(t).planes.map((p) => [p.id, p]));
    for (const after of mockPlanes(t + 5).planes) {
      const was = before.get(after.id);
      if (!was || was.track === undefined || was.groundSpeed === undefined || was.track !== after.track) continue;
      const predicted = deadReckon(was.lat, was.lon, was.track, was.groundSpeed, 5);
      // Within about 30m of where its own speed and track put it.
      expect(Math.abs(predicted.lat - after.lat)).toBeLessThan(0.0003);
      expect(Math.abs(predicted.lon - after.lon)).toBeLessThan(0.0004);
    }
  });
});
