/**
 * Encoded polyline decoding.
 *
 * Routing services return a path's geometry as a string rather than as a list
 * of coordinates, because a few hundred points as JSON numbers is several
 * kilobytes and the same points as deltas in base64-ish characters is a few
 * hundred bytes. The format is Google's, and Valhalla uses it with six decimal
 * places of precision rather than five — hence the parameter, and hence the
 * single most common way to get this wrong, which is to decode a precision-6
 * string at precision 5 and put the path in the wrong hemisphere.
 */

/**
 * Decodes an encoded polyline into `[lon, lat]` pairs.
 *
 * Longitude first, because that is the order GeoJSON and MapLibre want and
 * converting at the boundary is better than converting at every use.
 */
export function decodePolyline(encoded: string, precision = 6): [number, number][] {
  const factor = 10 ** precision;
  const points: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lon = 0;

  while (index < encoded.length) {
    lat += decodeSigned();
    lon += decodeSigned();
    points.push([lon / factor, lat / factor]);
  }

  return points;

  /**
   * Reads one zig-zag encoded varint.
   *
   * Each character carries five bits; the sixth signals that another
   * character follows. The low bit of the assembled value is the sign, which
   * is what lets a delta of -1 cost one character rather than five.
   */
  function decodeSigned(): number {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < encoded.length);
    return result & 1 ? ~(result >> 1) : result >> 1;
  }
}
