import { describe, expect, it } from 'vitest';
import { decodePolyline } from './polyline.ts';

describe('decodePolyline', () => {
  it('decodes the example from the format s own specification', () => {
    // The canonical precision-5 fixture: (38.5,-120.2) (40.7,-120.95) (43.252,-126.453).
    const points = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@', 5);
    expect(points).toHaveLength(3);
    expect(points[0][1]).toBeCloseTo(38.5, 5);
    expect(points[0][0]).toBeCloseTo(-120.2, 5);
    expect(points[2][1]).toBeCloseTo(43.252, 5);
    expect(points[2][0]).toBeCloseTo(-126.453, 5);
  });

  it('returns lon/lat, not lat/lon', () => {
    // Minneapolis: longitude is the large negative number.
    const [first] = decodePolyline(encode([[44.9784, -93.2699]], 6), 6);
    expect(first[0]).toBeLessThan(-90);
    expect(first[1]).toBeGreaterThan(40);
  });

  it('honours precision, which is how Valhalla differs from Google', () => {
    const encoded = encode([[44.9784, -93.2699]], 6);
    const right = decodePolyline(encoded, 6)[0];
    const wrong = decodePolyline(encoded, 5)[0];
    expect(right[1]).toBeCloseTo(44.9784, 6);
    // Decoding a precision-6 string at 5 is out by a factor of ten, which is
    // the bug this parameter exists to prevent.
    expect(wrong[1]).toBeCloseTo(449.784, 3);
  });

  it('round-trips a real-looking walking path', () => {
    const path: [number, number][] = [
      [44.9784, -93.2699],
      [44.9788, -93.2699],
      [44.9788, -93.2711],
      [44.9795, -93.2711],
    ];
    const decoded = decodePolyline(encode(path, 6), 6);
    expect(decoded).toHaveLength(path.length);
    decoded.forEach(([lon, lat], i) => {
      expect(lat).toBeCloseTo(path[i][0], 6);
      expect(lon).toBeCloseTo(path[i][1], 6);
    });
  });

  it('is empty for an empty string', () => {
    expect(decodePolyline('', 6)).toEqual([]);
  });
});

/** Encoder, used only to generate fixtures for the decoder under test. */
function encode(points: [number, number][], precision: number): string {
  const factor = 10 ** precision;
  let out = '';
  let lastLat = 0;
  let lastLon = 0;
  for (const [lat, lon] of points) {
    const iLat = Math.round(lat * factor);
    const iLon = Math.round(lon * factor);
    out += chunk(iLat - lastLat) + chunk(iLon - lastLon);
    lastLat = iLat;
    lastLon = iLon;
  }
  return out;

  function chunk(value: number): string {
    let v = value < 0 ? ~(value << 1) : value << 1;
    let s = '';
    while (v >= 0x20) {
      s += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>= 5;
    }
    return s + String.fromCharCode(v + 63);
  }
}
