import type { GtfsStore } from './gtfs/store.js';
import type { PatternSet } from './planner/patterns.js';
import { simplifyPath } from './geo.js';
import { log } from './log.js';

/**
 * The drawn shape of every route, as a GeoJSON FeatureCollection.
 *
 * Rendering the whole network as a faint underlay is what turns a scatter of
 * moving dots into a map you can read: a vehicle is obviously following a line
 * rather than drifting across a blank field.
 *
 * Two reductions keep it affordable. One representative shape per route and
 * direction, rather than every pattern — short-turns and branches mostly
 * retrace the same streets. And the geometry is simplified, because GTFS
 * shapes carry survey detail no map at city zoom can resolve.
 */
export interface RouteNetwork {
  type: 'FeatureCollection';
  features: {
    type: 'Feature';
    geometry: { type: 'LineString'; coordinates: [number, number][] };
    properties: { routeId: string; color: string; mode: string; rail: boolean };
  }[];
}

/** ~1e-4 degrees is roughly 11 metres — finer than the drawn line is wide. */
const SIMPLIFY_TOLERANCE = 1e-4;

export function buildRouteNetwork(store: GtfsStore, patterns: PatternSet): RouteNetwork {
  const started = Date.now();
  const features: RouteNetwork['features'] = [];
  let rawPoints = 0;
  let keptPoints = 0;

  // The longest pattern per route and direction is the best single stand-in
  // for the line; anything shorter is a variant that retraces part of it.
  const longest = new Map<string, number>();
  patterns.patterns.forEach((pattern, index) => {
    const key = `${pattern.routeIndex}:${pattern.directionId}`;
    const current = longest.get(key);
    if (current === undefined || pattern.stops.length > patterns.patterns[current].stops.length) {
      longest.set(key, index);
    }
  });

  for (const patternIndex of longest.values()) {
    const pattern = patterns.patterns[patternIndex];
    const route = store.routes[pattern.routeIndex];
    const raw = store.tripGeometry(pattern.trips[0]);
    if (raw.length < 2) continue;

    rawPoints += raw.length;
    const coordinates = simplifyPath(raw, SIMPLIFY_TOLERANCE).map(
      ([lon, lat]) => [round(lon), round(lat)] as [number, number],
    );
    if (coordinates.length < 2) continue;
    keptPoints += coordinates.length;

    features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates },
      properties: {
        routeId: route.id,
        color: `#${route.color}`,
        mode: route.mode,
        // Rail is drawn a touch stronger: those lines are the spine of a
        // network and the ones riders navigate by.
        rail: route.mode === 'rail' || route.mode === 'tram' || route.mode === 'metro',
      },
    });
  }

  log.info(
    `network: ${features.length} route shapes, ${keptPoints} points ` +
      `(from ${rawPoints}) in ${Date.now() - started}ms`,
  );
  return { type: 'FeatureCollection', features };
}

/** Five decimals is about a metre — more than the drawn line can show. */
function round(value: number): number {
  return Math.round(value * 1e5) / 1e5;
}
