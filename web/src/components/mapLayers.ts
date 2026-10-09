import type * as maplibregl from 'maplibre-gl';
import type { Palette } from '../lib/palette.ts';
import { MODE_TO_GLYPH, PLANE_ICON, VEHICLE_ICON } from './mapIcons.ts';

/**
 * Everything this app draws on the map, in draw order, and how it changes
 * with theme and selection.
 *
 * The visual language is a route diagram's. METRO lines are thick and
 * confident, each with a casing in the ground colour so that where two
 * cross, they read as two lines rather than a smudge. Local buses are a quiet
 * wash at metro scale and gain weight as you zoom in. Stops are circles;
 * interchanges are larger hollow ones. Selecting something dims everything
 * that is not about it, rather than only brightening what is.
 */

type Expr = maplibregl.ExpressionSpecification;

export const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

/**
 * Reads and writes a paint property named at runtime.
 *
 * MapLibre types every paint property's value separately, which a table of
 * (layer, property, value) rows — the dimming list below, the theme sync —
 * cannot express. The values are this app's own constants, so the check is
 * given up here, in one place, rather than cast at every call.
 */
export function setPaint(map: maplibregl.Map, layer: string, property: string, value: unknown): void {
  (map.setPaintProperty as (layer: string, name: string, value: unknown) => void).call(map, layer, property, value);
}

export function getPaint(map: maplibregl.Map, layer: string, property: string): unknown {
  return (map.getPaintProperty as (layer: string, name: string) => unknown).call(map, layer, property);
}

/** Map text, in the faces the glyph server actually has. */
export const FONT_REGULAR = ['Noto Sans Regular'];
export const FONT_BOLD = ['Noto Sans Bold'];

/** Below this zoom, vehicles that overlap on screen gather into counted discs. */
export const GROUP_BELOW_ZOOM = 12;

/**
 * How big a vehicle's plate is drawn, by zoom, as a multiple of its artwork:
 * [zoom, multiple] pairs, kept as data so the grouping can read the same
 * curve the map draws.
 *
 * It keeps shrinking as the map zooms out rather than stopping at a floor. A
 * phone shows the whole metro about two zoom levels further out than a
 * laptop does, and a floor sized for the laptop's view made every bus on a
 * phone a coin the width of a neighbourhood. From zoom 11 in, the sizes are
 * what they always were.
 */
const VEHICLE_SIZE_STOPS: [number, number][] = [[7, 0.26], [9, 0.38], [11, 0.68], [13, 0.9], [16, 1.15]];
const VEHICLE_SIZE: Expr = ['interpolate', ['linear'], ['zoom'], ...VEHICLE_SIZE_STOPS.flat()];

/** Half a plate at a multiple of 1, in pixels: the 40-pixel artwork less its halo room. */
const PLATE_HALF_PX = 14;

/**
 * A group's disc: bigger for more vehicles, and smaller the further out the
 * map is. Radii in pixels for at least 1, 10, 25, 60 and 150 vehicles, at
 * zoom 8 and at zoom 11, eased between and held beyond.
 */
const GROUP_DISC_COUNTS = [10, 25, 60, 150];
const GROUP_DISC_AT: [number, number[]][] = [
  [8, [7, 8.5, 10, 11.5, 13]],
  [11, [9.5, 11.5, 13.5, 15.5, 18]],
];
const GROUP_DISC_RADIUS: Expr = [
  'interpolate',
  ['linear'],
  ['zoom'],
  ...GROUP_DISC_AT.flatMap(([zoom, radii]): [number, Expr] => [
    zoom,
    ['step', ['get', 'count'], radii[0], ...GROUP_DISC_COUNTS.flatMap((count, i) => [count, radii[i + 1]])],
  ]),
];

const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

/** A group disc's drawn radius in pixels, as `GROUP_DISC_RADIUS` draws it. */
export function groupDiscRadius(count: number, zoom: number): number {
  const tier = GROUP_DISC_COUNTS.filter((threshold) => count >= threshold).length;
  const [[z0, near], [z1, far]] = GROUP_DISC_AT;
  return near[tier] + clamp01((zoom - z0) / (z1 - z0)) * (far[tier] - near[tier]);
}

/** Half a lone vehicle's plate in pixels, as `VEHICLE_SIZE` draws it. */
export function vehiclePlateRadius(zoom: number): number {
  const stops = VEHICLE_SIZE_STOPS;
  let size = stops[stops.length - 1][1];
  if (zoom <= stops[0][0]) size = stops[0][1];
  else {
    for (let i = 1; i < stops.length; i++) {
      const [z1, s1] = stops[i];
      if (zoom > z1) continue;
      const [z0, s0] = stops[i - 1];
      size = s0 + ((zoom - z0) / (z1 - z0)) * (s1 - s0);
      break;
    }
  }
  return PLATE_HALF_PX * size;
}

/**
 * How close together, in screen pixels, vehicles must be to gather into one
 * group at a zoom. Follows the plates' drawn size: close enough that their
 * plates would pile up. Groups are then merged wherever their discs would
 * touch (see `groupVehicles`), so a busy downtown reads as one count rather
 * than a stack of overlapping ones.
 */
export function groupMergeRadius(zoom: number): number {
  return 14 + clamp01((zoom - 8) / (GROUP_BELOW_ZOOM - 8)) * 8;
}

/** From this zoom the busiest bus stops are drawn too, not only line stops. */
const MAJOR_STOPS_FROM_ZOOM = 12;
/** Vehicles pulling in to stops are linked to them from this zoom in. */
export const APPROACH_FROM_ZOOM = 15;

/** Aircraft on the ground are only drawn from this zoom, where an airport is a place. */
export const GROUND_PLANES_FROM_ZOOM = 13;

/** Properties that are absent mean "no", not "error". */
const flag = (name: string): Expr => ['boolean', ['get', name], false];

/** Past this zoom every alerted stop is drawn on its own. */
const ALERTS_CLUSTER_MAX_ZOOM = 13;
/** In force now: a stop's own flag, or any stop inside a cluster. */
const ALERT_LIVE: Expr = ['case', ['has', 'point_count'], ['>', ['get', 'live'], 0], flag('active')];
/**
 * How bad, lower being worse. A stop already carries its worst alert, those
 * in force first; a cluster ranks its stops the same way, so a closure that
 * is only coming does not make a disc of detours in force look closed.
 */
const ALERT_RANK: Expr = [
  'case',
  ['all', ['has', 'point_count'], ['>', ['get', 'live'], 0]],
  ['get', 'liveRank'],
  ['get', 'rank'],
];
const ALERT_CLUSTER_RADIUS: Expr = ['step', ['get', 'point_count'], 11, 10, 14, 40, 18];

/** Red for closures, amber for detours and the like, grey for notices. */
function alertTone(p: Palette): Expr {
  return ['match', ALERT_RANK, 0, p.danger, 1, p.late, p.muted];
}

/**
 * The ripple's rings, one layer per marker size, each sized by a plain
 * number. A radius that read `point_count` would be data-driven, and MapLibre
 * re-tiles a source whenever one of those is restyled: two dozen times a
 * second, for a ripple. The cluster sizes are `ALERT_CLUSTER_RADIUS`'s steps.
 */
export const ALERT_PULSE_RINGS: { id: string; marker: Expr; radius: number }[] = [
  { id: 'alerts-pulse', marker: ['!', ['has', 'point_count']], radius: 6 },
  ...[11, 14, 18].map((radius) => ({
    id: `alerts-pulse-${radius}`,
    marker: ['all', ['has', 'point_count'], ['==', ALERT_CLUSTER_RADIUS, radius]] as Expr,
    radius,
  })),
];

/** How far past its marker's edge the ripple is, `phase` (0–1) through one beat. */
export function alertPulseSpread(phase: number): number {
  return 4 + phase * 14;
}
const NOT_GROUPED: Expr = ['!', flag('grouped')];

/**
 * The filter for a stop-badge layer: the selected stop only, or nothing. A
 * major stop is drawn from both sources, so the minor layer leaves it out.
 */
export function stopBadgeFilter(layer: 'major-stop-badges' | 'stop-badges', stopId: string | null): Expr {
  const selected: Expr = ['==', ['get', 'id'], stopId ?? ''];
  return layer === 'stop-badges' ? ['all', ['!', flag('major')], selected] : selected;
}

const TIER: Expr = ['get', 'tier'];

/** A per-tier value: rail, branded bus line, ordinary bus. */
const byTier = (rail: number, branded: number, bus: number): Expr => ['match', TIER, 'rail', rail, 'branded', branded, bus];

const NETWORK_WIDTH: Expr = [
  'interpolate',
  ['exponential', 1.4],
  ['zoom'],
  9, byTier(2.6, 1.7, 0.6),
  12, byTier(4.2, 3, 1.1),
  15, byTier(6.8, 5, 2.4),
  18, byTier(12, 9, 5),
];

const CASING_WIDTH: Expr = [
  'interpolate',
  ['exponential', 1.4],
  ['zoom'],
  9, byTier(5, 3.8, 0),
  12, byTier(7.6, 6, 0),
  15, byTier(10.8, 8.6, 0),
  18, byTier(17, 13.6, 0),
];

/** Opacity per tier at each zoom stop, before any dimming for focus. */
const NETWORK_OPACITY_STOPS: [number, [number, number, number]][] = [
  [9, [0.95, 0.85, 0.14]],
  [12, [0.95, 0.9, 0.3]],
  [15, [0.95, 0.92, 0.55]],
];

/**
 * The network's opacity, with everything off the focused routes knocked back
 * to a fifth. Zoom expressions must sit at the top of a paint value, so the
 * focus test goes inside each zoom stop rather than around the whole thing.
 */
function networkOpacity(focus: Expr | null): Expr {
  const stops: (number | Expr)[] = [];
  for (const [zoom, [rail, branded, bus]] of NETWORK_OPACITY_STOPS) {
    const normal = byTier(rail, branded, bus);
    const dimmed = byTier(rail * 0.18, branded * 0.18, bus * 0.35);
    stops.push(zoom, focus ? ['case', focus, normal, dimmed] : normal);
  }
  return ['interpolate', ['linear'], ['zoom'], ...stops] as Expr;
}

/** True for features on any of the given routes, by `routeId` or a stop's `routeKey`. */
function onRoutes(ids: string[], property: 'routeId' | 'routeKey'): Expr {
  if (property === 'routeId') return ['in', ['get', 'routeId'], ['literal', ids]];
  // A stop lists its routes as ",A,B,C," so any one can be found by substring.
  return ['any', ...ids.map((id): Expr => ['in', `,${id},`, ['get', 'routeKey']])] as Expr;
}

const STALE_THEN_LIVE = (live: number, stale: number): Expr => ['case', flag('stale'), stale, live];

function vehicleOpacity(focus: Expr | null): Expr {
  return focus ? ['case', focus, STALE_THEN_LIVE(1, 0.38), 0.2] : STALE_THEN_LIVE(1, 0.38);
}

/** Major stops at metro scale, every stop once you are looking at a street. */
const MAJOR_STOP_RADIUS: Expr = [
  'interpolate',
  ['linear'],
  ['zoom'],
  10, ['case', flag('interchange'), 3.4, 2.1],
  13, ['case', flag('interchange'), 5.6, 3.4],
  16, ['case', flag('interchange'), 8.6, 5.4],
];

const MAJOR_STOP_STROKE: Expr = [
  'interpolate',
  ['linear'],
  ['zoom'],
  10, ['case', flag('interchange'), 1.7, 1.1],
  13, ['case', flag('interchange'), 2.4, 1.6],
  16, ['case', flag('interchange'), 3.2, 2.2],
];

/**
 * Declares every source and layer, once, in draw order. Returns true when it
 * created them, which tells the caller the sources are empty and need filling.
 */
export function ensureLayers(map: maplibregl.Map, p: Palette): boolean {
  if (map.getLayer('vehicles-hit')) return false;

  for (const id of [
    'network', 'itinerary', 'itinerary-points', 'stops', 'major-stops', 'vehicles', 'vehicle-groups',
    'endpoints', 'journey-trail', 'journey-traveller', 'vehicle-trip', 'vehicle-trip-stops', 'isochrone',
    'approach-lines', 'approach-rings', 'planes', 'plane-ahead', 'plane-ahead-end',
  ]) {
    if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: EMPTY });
  }
  // Alerted stops gather into counted discs until there is room for them,
  // each disc remembering the worst alert inside it and the worst in force.
  if (!map.getSource('alerts')) {
    map.addSource('alerts', {
      type: 'geojson',
      data: EMPTY,
      cluster: true,
      clusterRadius: 42,
      clusterMaxZoom: ALERTS_CLUSTER_MAX_ZOOM,
      clusterProperties: {
        rank: ['min', ['get', 'rank']],
        // Stops not yet in force count as 9, past every real rank, so this is
        // the worst of those in force. It is read only when there are some.
        liveRank: ['min', ['case', ['get', 'active'], ['get', 'rank'], 9]],
        live: ['+', ['case', ['get', 'active'], 1, 0]],
      },
    });
  }
  // Line metrics are what let a line be drawn on from one end, or fade.
  for (const id of ['route-shape', 'vehicle-trip-full', 'vehicle-trail', 'plane-trail']) {
    if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: EMPTY, lineMetrics: true });
  }

  // --- How far you can get, under everything else ---------------------------
  // One neutral tone at three strengths: the network's reach is a question of
  // how far, not of which line, so it borrows no route's colour.
  map.addLayer({
    id: 'isochrone-fill',
    type: 'fill',
    source: 'isochrone',
    paint: {
      'fill-color': p.text,
      'fill-opacity': ['match', ['get', 'band'], 10, 0.26, 20, 0.15, 0.07],
      // Neighbouring cells meet exactly; antialiasing would draw the seams.
      'fill-antialias': false,
    },
  });

  // --- The network ----------------------------------------------------------
  map.addLayer({
    id: 'network-casing',
    type: 'line',
    source: 'network',
    minzoom: 10,
    filter: ['!=', TIER, 'bus'],
    layout: { 'line-cap': 'round', 'line-join': 'round', 'line-sort-key': byTier(2, 1, 0) },
    paint: { 'line-color': p.casing, 'line-width': CASING_WIDTH },
  });
  map.addLayer({
    id: 'network-line',
    type: 'line',
    source: 'network',
    layout: { 'line-cap': 'round', 'line-join': 'round', 'line-sort-key': byTier(2, 1, 0) },
    paint: { 'line-color': ['get', 'color'], 'line-width': NETWORK_WIDTH, 'line-opacity': networkOpacity(null) },
  });
  // The focused lines, redrawn full strength over the dimmed rest.
  map.addLayer({
    id: 'network-highlight',
    type: 'line',
    source: 'network',
    filter: ['in', ['get', 'routeId'], ['literal', []]],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['get', 'color'],
      'line-width': ['interpolate', ['exponential', 1.4], ['zoom'], 9, 3, 12, 4.6, 15, 7.2, 18, 12],
    },
  });

  // --- A browsed route, drawn on from one end -------------------------------
  map.addLayer({
    id: 'route-shape-casing',
    type: 'line',
    source: 'route-shape',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-width': 10, 'line-gradient': solid(p.casing) },
  });
  map.addLayer({
    id: 'route-shape-line',
    type: 'line',
    source: 'route-shape',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-width': 5.5, 'line-gradient': solid('#888888') },
  });

  // --- The selected vehicle's trip -------------------------------------------
  // Drawn on whole, then swapped for the version cut at the vehicle: the road
  // already travelled faded, the road ahead bold.
  map.addLayer({
    id: 'vehicle-trip-reveal-casing',
    type: 'line',
    source: 'vehicle-trip-full',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-width': 9, 'line-gradient': solid(p.casing) },
  });
  map.addLayer({
    id: 'vehicle-trip-reveal',
    type: 'line',
    source: 'vehicle-trip-full',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-width': 5, 'line-gradient': solid('#888888') },
  });
  map.addLayer({
    id: 'vehicle-trip-casing',
    type: 'line',
    source: 'vehicle-trip',
    filter: ['==', ['get', 'part'], 'ahead'],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': p.casing, 'line-width': 9 },
  });
  map.addLayer({
    id: 'vehicle-trip-line',
    type: 'line',
    source: 'vehicle-trip',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['get', 'color'],
      'line-width': ['case', ['==', ['get', 'part'], 'ahead'], 5, 3],
      'line-opacity': ['case', ['==', ['get', 'part'], 'ahead'], 1, 0.35],
    },
  });
  map.addLayer({
    id: 'vehicle-trip-stops',
    type: 'circle',
    source: 'vehicle-trip-stops',
    minzoom: 11,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 2.6, 15, 4.6],
      'circle-color': p.stopFill,
      'circle-stroke-color': ['get', 'color'],
      'circle-stroke-width': 2,
    },
  });
  map.addLayer({
    id: 'vehicle-trail-line',
    type: 'line',
    source: 'vehicle-trail',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-width': ['interpolate', ['linear'], ['zoom'], 11, 3, 16, 6],
      'line-gradient': ['interpolate', ['linear'], ['line-progress'], 0, 'rgba(0,0,0,0)', 1, 'rgba(0,0,0,0.6)'],
    },
  });

  // --- A planned trip -----------------------------------------------------------
  map.addLayer({
    id: 'itinerary-casing',
    type: 'line',
    source: 'itinerary',
    paint: { 'line-color': p.casing, 'line-width': 10, 'line-opacity': 0.95 },
    layout: { 'line-cap': 'round', 'line-join': 'round' },
  });
  map.addLayer({
    id: 'itinerary-line',
    type: 'line',
    source: 'itinerary',
    paint: {
      'line-color': ['get', 'color'],
      'line-width': 5.5,
      // Walking legs are dashed, the convention on every transit map.
      'line-dasharray': ['case', ['get', 'walk'], ['literal', [1, 1.6]], ['literal', [1, 0]]],
    },
    layout: { 'line-cap': 'butt', 'line-join': 'round' },
  });

  // --- Stops ------------------------------------------------------------------
  // Major stops — stations, METRO stops, the busiest corners — from metro
  // scale; every other stop only once you are looking at a street.
  map.addLayer({
    id: 'stops-circle',
    type: 'circle',
    source: 'stops',
    minzoom: 14.5,
    filter: ['!', flag('major')],
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 14.5, 2, 17, 4.6],
      'circle-color': p.stopFill,
      'circle-stroke-color': p.stopStroke,
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 14.5, 1.1, 17, 1.8],
      'circle-opacity': ['interpolate', ['linear'], ['zoom'], 14.5, 0, 15, 1],
      'circle-stroke-opacity': ['interpolate', ['linear'], ['zoom'], 14.5, 0, 15, 1],
    },
  });
  // From the widest view only stations and stops on rail or branded lines,
  // the stops a printed network map shows; the busiest bus stops join them
  // once there is room, or downtown alone would be a field of dots.
  map.addLayer({
    id: 'line-stops-circle',
    type: 'circle',
    source: 'major-stops',
    minzoom: 9.5,
    maxzoom: MAJOR_STOPS_FROM_ZOOM,
    filter: flag('onLine'),
    paint: {
      'circle-radius': MAJOR_STOP_RADIUS,
      'circle-color': p.stopFill,
      'circle-stroke-color': p.stopStroke,
      'circle-stroke-width': MAJOR_STOP_STROKE,
      'circle-opacity': majorFade(),
      'circle-stroke-opacity': majorFade(),
    },
  });
  map.addLayer({
    id: 'major-stops-circle',
    type: 'circle',
    source: 'major-stops',
    minzoom: MAJOR_STOPS_FROM_ZOOM,
    paint: {
      'circle-radius': MAJOR_STOP_RADIUS,
      'circle-color': p.stopFill,
      'circle-stroke-color': p.stopStroke,
      'circle-stroke-width': MAJOR_STOP_STROKE,
    },
  });
  map.addLayer({
    id: 'major-stops-label',
    type: 'symbol',
    source: 'major-stops',
    minzoom: 12,
    layout: {
      // Interchanges named first, the other major stops a little closer in.
      'text-field': ['step', ['zoom'], ['case', flag('interchange'), ['get', 'name'], ''], 13.5, ['get', 'name']],
      'text-font': ['case', flag('interchange'), ['literal', FONT_BOLD], ['literal', FONT_REGULAR]] as unknown as string[],
      'text-size': ['interpolate', ['linear'], ['zoom'], 12, 10, 16, 12.5],
      'text-transform': 'uppercase',
      'text-letter-spacing': 0.06,
      'text-offset': [0, 0.95],
      'text-anchor': 'top',
      'text-max-width': 9,
      'text-optional': true,
    },
    paint: { 'text-color': p.stopLabel, 'text-halo-color': p.halo, 'text-halo-width': 1.6 },
  });
  map.addLayer({
    id: 'stops-label',
    type: 'symbol',
    source: 'stops',
    minzoom: 16,
    filter: ['!', flag('major')],
    layout: {
      'text-field': ['get', 'name'],
      'text-font': FONT_REGULAR,
      'text-size': 10.5,
      'text-transform': 'uppercase',
      'text-letter-spacing': 0.05,
      'text-offset': [0, 0.9],
      'text-anchor': 'top',
      'text-max-width': 9,
      'text-optional': true,
    },
    paint: { 'text-color': p.stopLabel, 'text-halo-color': p.halo, 'text-halo-width': 1.5 },
  });
  // Which routes call here, on a plate above the selected stop's pin. Only the
  // selected stop: a plate on every stop turned the map into a scatter of
  // route numbers. TransitMap points the filters at the selection.
  for (const [id, source] of [
    ['major-stop-badges', 'major-stops'],
    ['stop-badges', 'stops'],
  ] as const) {
    map.addLayer({
      id,
      type: 'symbol',
      source,
      filter: stopBadgeFilter(id, null),
      layout: {
        'text-field': ['get', 'badges'],
        'text-font': FONT_BOLD,
        'text-size': 9.5,
        'text-letter-spacing': 0.04,
        // Clear of the 42px pin, which stands on the stop.
        'text-offset': [0, -4.9],
        'text-anchor': 'bottom',
        'text-allow-overlap': true,
        'icon-allow-overlap': true,
        'icon-image': 'badge',
        'icon-text-fit': 'both',
        'icon-text-fit-padding': [1, 4, 1, 4],
      },
      paint: { 'text-color': p.badgeText, 'icon-color': p.badge, 'icon-halo-color': p.rule, 'icon-halo-width': 1 },
    });
  }

  // --- Vehicles pulling in to a stop -------------------------------------------
  // A connector from each arriving vehicle to its stop: faint and dashed at
  // the edge of range, bolder as it closes in, solid green while it stands
  // at the stop. Beneath the vehicles, so the connector runs out from under one.
  // In the text colour, not the route's: a vehicle runs along its own line to
  // the stop, so a route-coloured connector would vanish into the track.
  map.addLayer({
    id: 'approach-line',
    type: 'line',
    source: 'approach-lines',
    minzoom: APPROACH_FROM_ZOOM,
    filter: ['!', ['get', 'stopped']],
    layout: { 'line-cap': 'round' },
    paint: {
      'line-color': p.text,
      'line-width': ['interpolate', ['linear'], ['get', 'closeness'], 0, 2, 1, 4],
      'line-opacity': ['interpolate', ['linear'], ['get', 'closeness'], 0, 0.35, 1, 1],
      'line-dasharray': [1.5, 1.5],
    },
  });
  map.addLayer({
    id: 'approach-line-stopped',
    type: 'line',
    source: 'approach-lines',
    minzoom: APPROACH_FROM_ZOOM,
    filter: ['get', 'stopped'],
    layout: { 'line-cap': 'round' },
    paint: { 'line-color': p.live, 'line-width': 5 },
  });
  map.addLayer({
    id: 'approach-ring',
    type: 'circle',
    source: 'approach-rings',
    minzoom: APPROACH_FROM_ZOOM,
    paint: {
      // Standing at the stop, the ring opens out past the vehicle's own
      // marker, with a soft green glow, so it shows around the vehicle.
      'circle-radius': ['case', ['get', 'stopped'], 20, 12],
      'circle-color': ['case', ['get', 'stopped'], p.live, 'transparent'],
      'circle-opacity': 0.18,
      'circle-stroke-color': ['case', ['get', 'stopped'], p.live, p.text],
      'circle-stroke-width': ['case', ['get', 'stopped'], 3, 2],
      'circle-stroke-opacity': ['interpolate', ['linear'], ['get', 'closeness'], 0, 0.3, 1, 1],
    },
  });

  // --- Ends of a planned trip ---------------------------------------------------
  map.addLayer({
    id: 'itinerary-stops',
    type: 'circle',
    source: 'itinerary-points',
    paint: {
      'circle-radius': 6,
      'circle-color': p.stopFill,
      'circle-stroke-color': ['get', 'color'],
      'circle-stroke-width': 3.5,
    },
  });
  map.addLayer({
    id: 'endpoints-halo',
    type: 'circle',
    source: 'endpoints',
    paint: { 'circle-radius': 11, 'circle-color': ['get', 'color'], 'circle-opacity': 0.22 },
  });
  map.addLayer({
    id: 'endpoints-dot',
    type: 'circle',
    source: 'endpoints',
    paint: {
      'circle-radius': 6.5,
      'circle-color': ['get', 'color'],
      'circle-stroke-color': p.stopFill,
      'circle-stroke-width': 2.5,
    },
  });

  // --- Aircraft overhead -----------------------------------------------------------
  // Scenery, not service: thin yellow silhouettes beneath every bus and train,
  // fainter and a touch smaller the higher they fly, so the jets crossing at
  // 35,000ft recede and the arrivals low over the river are the ones you
  // notice. No route colour, and a name only once you are close or have
  // chosen one.
  map.addLayer({
    id: 'plane-trail-line',
    type: 'line',
    source: 'plane-trail',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-width': ['interpolate', ['linear'], ['zoom'], 9, 1.6, 15, 3],
      'line-gradient': planeTrailGradient(p.plane),
    },
  });
  // Where the chosen plane is going: a dashed great circle to its
  // destination, or along its heading when that is all there is to go on.
  map.addLayer({
    id: 'plane-ahead-line',
    type: 'line',
    source: 'plane-ahead',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': p.plane,
      'line-width': ['interpolate', ['linear'], ['zoom'], 6, 1.4, 14, 2.4],
      'line-dasharray': [2, 2],
      'line-opacity': 0.85,
    },
  });
  map.addLayer({
    id: 'plane-ahead-end',
    type: 'circle',
    source: 'plane-ahead-end',
    paint: {
      'circle-radius': 5,
      'circle-color': p.stopFill,
      'circle-stroke-color': p.plane,
      'circle-stroke-width': 2,
    },
  });
  map.addLayer({
    id: 'plane-ahead-label',
    type: 'symbol',
    source: 'plane-ahead-end',
    layout: {
      'text-field': ['get', 'label'],
      'text-font': FONT_BOLD,
      'text-size': 11,
      'text-letter-spacing': 0.06,
      'text-anchor': 'top',
      'text-offset': [0, 0.8],
      'text-allow-overlap': true,
    },
    paint: { 'text-color': p.text, 'text-halo-color': p.halo, 'text-halo-width': 1.6 },
  });
  map.addLayer({
    id: 'planes-selected',
    type: 'circle',
    source: 'planes',
    filter: ['==', ['get', 'id'], ''],
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 12, 16, 20],
      'circle-color': p.plane,
      'circle-opacity': 0.16,
      'circle-stroke-color': p.plane,
      'circle-stroke-width': 1.2,
      'circle-stroke-opacity': 0.8,
    },
  });
  map.addLayer({
    id: 'planes-icon',
    type: 'symbol',
    source: 'planes',
    layout: {
      'icon-image': PLANE_ICON,
      'icon-rotate': ['get', 'track'],
      'icon-rotation-alignment': 'map',
      'icon-size': [
        'interpolate',
        ['linear'],
        ['zoom'],
        8, ['*', 0.6, PLANE_ALTITUDE_SCALE],
        12, ['*', 0.78, PLANE_ALTITUDE_SCALE],
        16, ['*', 1, PLANE_ALTITUDE_SCALE],
      ] as Expr,
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
    paint: {
      'icon-color': p.plane,
      'icon-halo-color': p.casing,
      'icon-halo-width': 1.8,
      'icon-opacity': planeOpacity(1, null),
    },
  });
  // Callsigns, once you are looking at a neighbourhood rather than a metro,
  // and only where there is room: they give way to every other label.
  map.addLayer({
    id: 'planes-label',
    type: 'symbol',
    source: 'planes',
    minzoom: 12,
    layout: {
      'text-field': ['get', 'label'],
      'text-font': FONT_REGULAR,
      'text-size': 10,
      'text-letter-spacing': 0.04,
      'text-anchor': 'left',
      'text-offset': [1.2, 0],
      'text-optional': true,
    },
    paint: {
      'text-color': p.plane,
      'text-halo-color': p.halo,
      'text-halo-width': 1.4,
      'text-opacity': planeOpacity(0.9, null),
    },
  });
  // The chosen or hovered plane: its callsign and height, at any zoom.
  map.addLayer({
    id: 'planes-label-focus',
    type: 'symbol',
    source: 'planes',
    filter: ['in', ['get', 'id'], ['literal', []]],
    layout: {
      'text-field': ['format', ['get', 'label'], { 'text-font': ['literal', FONT_BOLD] }, '  ', {}, ['get', 'height'], {}],
      'text-font': FONT_REGULAR,
      'text-size': 11,
      'text-letter-spacing': 0.03,
      'text-anchor': 'left',
      'text-offset': [1.35, 0],
      'text-allow-overlap': true,
      'text-ignore-placement': true,
    },
    paint: { 'text-color': p.text, 'text-halo-color': p.halo, 'text-halo-width': 1.6 },
  });
  map.addLayer({
    id: 'planes-hit',
    type: 'circle',
    source: 'planes',
    paint: { 'circle-radius': 14, 'circle-opacity': 0 },
  });

  // --- Service alerts, while the alerts view is open ---------------------------
  // Over the stops and the aircraft, under the vehicles. A quiet disc per
  // cluster with the worst tone as its ring, and one dot per stop once
  // zoomed in; only what is severe and in force right now gets the slow
  // ripple.
  for (const ring of ALERT_PULSE_RINGS) {
    map.addLayer({
      id: ring.id,
      type: 'circle',
      source: 'alerts',
      filter: ['all', ring.marker, ['==', ALERT_RANK, 0], ALERT_LIVE],
      paint: {
        'circle-radius': ring.radius + alertPulseSpread(0),
        'circle-color': 'transparent',
        'circle-stroke-color': alertTone(p),
        'circle-stroke-width': 1.6,
        'circle-stroke-opacity': 0,
        // The ripple is moved on a frame at a time; the usual eased
        // transition would trail it and pull each ring back as it grew.
        'circle-radius-transition': { duration: 0, delay: 0 },
        'circle-stroke-opacity-transition': { duration: 0, delay: 0 },
      },
    });
  }
  map.addLayer({
    id: 'alerts-cluster',
    type: 'circle',
    source: 'alerts',
    filter: ['has', 'point_count'],
    paint: {
      'circle-color': p.surface2,
      'circle-radius': ALERT_CLUSTER_RADIUS,
      'circle-stroke-color': alertTone(p),
      'circle-stroke-width': 2.2,
      'circle-opacity': 0.92,
      'circle-stroke-opacity': ['case', ALERT_LIVE, 1, 0.45],
    },
  });
  map.addLayer({
    id: 'alerts-cluster-count',
    type: 'symbol',
    source: 'alerts',
    filter: ['has', 'point_count'],
    layout: {
      'text-field': ['get', 'point_count_abbreviated'],
      'text-font': FONT_BOLD,
      'text-size': 11,
      'text-allow-overlap': true,
      'text-ignore-placement': true,
    },
    paint: { 'text-color': p.text },
  });
  map.addLayer({
    id: 'alerts-dot',
    type: 'circle',
    source: 'alerts',
    filter: ['!', ['has', 'point_count']],
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 4.5, 14, 6.5, 17, 9],
      'circle-color': alertTone(p),
      'circle-opacity': ['case', ALERT_LIVE, 1, 0.4],
      'circle-stroke-color': p.casing,
      'circle-stroke-width': 1.6,
    },
  });
  map.addLayer({
    id: 'alerts-mark',
    type: 'symbol',
    source: 'alerts',
    minzoom: 14,
    filter: ['!', ['has', 'point_count']],
    layout: {
      'text-field': '!',
      'text-font': FONT_BOLD,
      'text-size': ['interpolate', ['linear'], ['zoom'], 14, 9, 17, 12],
      'text-allow-overlap': true,
      'text-ignore-placement': true,
    },
    paint: { 'text-color': p.casing, 'text-opacity': ['case', ALERT_LIVE, 1, 0.6] },
  });

  // --- Vehicles -------------------------------------------------------------------
  // Groups: a disc with a count, drawn where vehicles pile up on screen.
  map.addLayer({
    id: 'vehicle-groups-circle',
    type: 'circle',
    source: 'vehicle-groups',
    paint: {
      'circle-color': p.surface2,
      'circle-radius': GROUP_DISC_RADIUS,
      'circle-stroke-color': ['case', ['>', ['/', ['get', 'rail'], ['get', 'count']], 0.5], p.text, p.muted],
      'circle-stroke-width': 1.6,
    },
  });
  map.addLayer({
    id: 'vehicle-groups-count',
    type: 'symbol',
    source: 'vehicle-groups',
    layout: {
      'text-field': ['to-string', ['get', 'count']],
      'text-font': FONT_BOLD,
      'text-size': ['interpolate', ['linear'], ['zoom'], 8, 9.5, 11, 11],
      'text-allow-overlap': true,
      'text-ignore-placement': true,
    },
    paint: { 'text-color': p.text },
  });

  // The selected vehicle's halo, beneath its marker.
  map.addLayer({
    id: 'vehicles-selected',
    type: 'circle',
    source: 'vehicles',
    filter: ['==', ['get', 'id'], ''],
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 9, 10, 13, 16, 22],
      'circle-color': ['get', 'color'],
      'circle-opacity': 0.28,
      'circle-stroke-color': ['get', 'color'],
      'circle-stroke-width': 1.5,
    },
  });

  // A ring round every vehicle on the route being browsed, so the ones out
  // on it now stand out from the dimmed rest of the fleet.
  map.addLayer({
    id: 'vehicles-route',
    type: 'circle',
    source: 'vehicles',
    filter: ['all', NOT_GROUPED, ['in', ['get', 'routeId'], ['literal', []]]] as maplibregl.FilterSpecification,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 7, 10, 10, 16, 17],
      'circle-color': ['get', 'color'],
      'circle-opacity': 0.22,
      'circle-stroke-color': ['get', 'color'],
      'circle-stroke-width': 2,
    },
  });

  // The plate, nose and all, then the pictogram upright on top of it.
  map.addLayer({
    id: 'vehicles-dot',
    type: 'symbol',
    source: 'vehicles',
    filter: NOT_GROUPED,
    layout: {
      'icon-image': VEHICLE_ICON,
      'icon-rotate': ['case', flag('hasHeading'), ['get', 'bearing'], 0],
      'icon-rotation-alignment': 'map',
      'icon-size': VEHICLE_SIZE,
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
    paint: {
      'icon-color': ['get', 'color'],
      'icon-halo-color': p.casing,
      'icon-halo-width': 1.6,
      'icon-opacity': vehicleOpacity(null),
    },
  });
  map.addLayer({
    id: 'vehicles-glyph',
    type: 'symbol',
    source: 'vehicles',
    minzoom: 12.5,
    filter: NOT_GROUPED,
    layout: {
      'icon-image': MODE_TO_GLYPH,
      'icon-size': ['interpolate', ['linear'], ['zoom'], 12.5, 0.82, 13, 0.9, 16, 1.15],
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
    paint: {
      'icon-color': ['get', 'textColor'],
      'icon-opacity': ['interpolate', ['linear'], ['zoom'], 12.5, 0, 13, 1] as Expr,
    },
  });
  // The route number on a plate beside the vehicle, once there is room.
  map.addLayer({
    id: 'vehicles-label',
    type: 'symbol',
    source: 'vehicles',
    minzoom: 14,
    filter: NOT_GROUPED,
    layout: {
      'text-field': ['get', 'label'],
      'text-font': FONT_BOLD,
      'text-size': 10.5,
      'text-transform': 'uppercase',
      'text-letter-spacing': 0.03,
      'text-anchor': 'left',
      'text-offset': [1.35, 0],
      'icon-image': 'badge',
      'icon-text-fit': 'both',
      'icon-text-fit-padding': [1, 3, 1, 3],
      'icon-anchor': 'left',
      'text-optional': false,
    },
    paint: {
      'text-color': ['get', 'textColor'],
      'icon-color': ['get', 'color'],
      'icon-halo-color': p.casing,
      'icon-halo-width': 1.2,
      'text-opacity': vehicleOpacity(null),
      'icon-opacity': vehicleOpacity(null),
    },
  });
  // A generous invisible hit target: markers are small on a phone.
  map.addLayer({
    id: 'vehicles-hit',
    type: 'circle',
    source: 'vehicles',
    filter: NOT_GROUPED,
    paint: { 'circle-radius': 16, 'circle-opacity': 0 },
  });

  // --- The animated journey, above everything ---------------------------------
  map.addLayer({
    id: 'journey-trail',
    type: 'line',
    source: 'journey-trail',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['get', 'color'],
      'line-width': ['interpolate', ['linear'], ['zoom'], 11, 4, 15, 7],
      'line-opacity': 0.92,
    },
  });
  map.addLayer({
    id: 'journey-halo',
    type: 'circle',
    source: 'journey-traveller',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 12, 16, 22],
      'circle-color': ['get', 'color'],
      'circle-opacity': 0.24,
    },
  });
  map.addLayer({
    id: 'journey-traveller',
    type: 'circle',
    source: 'journey-traveller',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 6, 16, 10],
      'circle-color': ['get', 'color'],
      'circle-stroke-color': p.stopFill,
      'circle-stroke-width': 2.5,
    },
  });

  return true;
}

/** A line gradient of one colour throughout: "fully drawn". */
export function solid(color: string): Expr {
  return ['interpolate', ['linear'], ['line-progress'], 0, color, 1, color];
}

/** A line gradient drawn on to `progress` (0–1) and invisible beyond. */
function partial(color: string, progress: number): Expr {
  if (progress >= 1) return solid(color);
  const edge = Math.max(0.0001, progress);
  return ['interpolate', ['linear'], ['line-progress'], 0, color, edge, color, Math.min(1, edge + 0.0001), 'rgba(0,0,0,0)'];
}

/**
 * Draws lines on from one end to the other, like a pen along a route
 * diagram. Quick and mechanical — an ease-out over well under a second — and
 * cancellable, since a new selection can arrive before it has finished.
 */
export function revealLines(
  map: maplibregl.Map,
  layers: { id: string; color: string }[],
  durationMs = 650,
  onDone?: () => void,
): () => void {
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  let frame = 0;
  let cancelled = false;
  const start = performance.now();
  const step = () => {
    if (cancelled) return;
    const t = reduce || durationMs <= 0 ? 1 : Math.min(1, (performance.now() - start) / durationMs);
    const eased = 1 - Math.pow(1 - t, 3);
    for (const { id, color } of layers) {
      if (map.getLayer(id)) map.setPaintProperty(id, 'line-gradient', partial(color, eased));
    }
    if (t < 1) frame = requestAnimationFrame(step);
    else onDone?.();
  };
  step();
  return () => {
    cancelled = true;
    cancelAnimationFrame(frame);
  };
}

/**
 * The colours of the app's own furniture for a palette: casings, stop rings,
 * labels, badges, group discs. Route colours are the agency's and never change.
 */
export function syncOverlayTheme(map: maplibregl.Map, p: Palette): void {
  const set = (layer: string, property: string, value: unknown) => {
    if (map.getLayer(layer)) setPaint(map, layer, property, value);
  };
  set('network-casing', 'line-color', p.casing);
  set('isochrone-fill', 'fill-color', p.text);
  set('vehicle-trip-casing', 'line-color', p.casing);
  set('itinerary-casing', 'line-color', p.casing);
  set('route-shape-casing', 'line-gradient', solid(p.casing));
  for (const layer of ['stops-circle', 'line-stops-circle', 'major-stops-circle']) {
    set(layer, 'circle-color', p.stopFill);
    set(layer, 'circle-stroke-color', p.stopStroke);
  }
  for (const layer of ['vehicle-trip-stops', 'itinerary-stops']) set(layer, 'circle-color', p.stopFill);
  for (const layer of ['endpoints-dot', 'journey-traveller']) set(layer, 'circle-stroke-color', p.stopFill);
  for (const layer of ['major-stops-label', 'stops-label']) {
    set(layer, 'text-color', p.stopLabel);
    set(layer, 'text-halo-color', p.halo);
  }
  for (const layer of ['major-stop-badges', 'stop-badges']) {
    set(layer, 'text-color', p.badgeText);
    set(layer, 'icon-color', p.badge);
    set(layer, 'icon-halo-color', p.rule);
  }
  for (const layer of ['vehicles-dot', 'vehicles-label']) set(layer, 'icon-halo-color', p.casing);
  set('approach-line-stopped', 'line-color', p.live);
  set('approach-line', 'line-color', p.text);
  set('approach-ring', 'circle-color', ['case', ['get', 'stopped'], p.live, 'transparent']);
  set('approach-ring', 'circle-stroke-color', ['case', ['get', 'stopped'], p.live, p.text]);
  set('vehicle-groups-circle', 'circle-color', p.surface2);
  set('vehicle-groups-circle', 'circle-stroke-color', [
    'case',
    ['>', ['/', ['get', 'rail'], ['get', 'count']], 0.5],
    p.text,
    p.muted,
  ]);
  set('vehicle-groups-count', 'text-color', p.text);
  set('planes-icon', 'icon-color', p.plane);
  set('planes-icon', 'icon-halo-color', p.casing);
  set('planes-label', 'text-color', p.plane);
  set('planes-label', 'text-halo-color', p.halo);
  set('planes-label-focus', 'text-color', p.text);
  set('planes-label-focus', 'text-halo-color', p.halo);
  set('planes-selected', 'circle-color', p.plane);
  set('planes-selected', 'circle-stroke-color', p.plane);
  set('plane-trail-line', 'line-gradient', planeTrailGradient(p.plane));
  set('plane-ahead-line', 'line-color', p.plane);
  set('plane-ahead-end', 'circle-color', p.stopFill);
  set('plane-ahead-end', 'circle-stroke-color', p.plane);
  set('plane-ahead-label', 'text-color', p.text);
  set('plane-ahead-label', 'text-halo-color', p.halo);
  for (const layer of ['alerts-cluster', ...ALERT_PULSE_RINGS.map((ring) => ring.id)]) {
    set(layer, 'circle-stroke-color', alertTone(p));
  }
  set('alerts-cluster', 'circle-color', p.surface2);
  set('alerts-cluster-count', 'text-color', p.text);
  set('alerts-dot', 'circle-color', alertTone(p));
  set('alerts-dot', 'circle-stroke-color', p.casing);
  set('alerts-mark', 'text-color', p.casing);
}

/**
 * What the map is about: the routes in question, and why.
 *
 * A stop's lines are redrawn bold, because the stop is the subject and its
 * lines are what it offers. A vehicle's, a browsed route's and a planned
 * trip's are not: each has its own outline drawn on top, and a bold copy of
 * the whole route underneath would only smother it.
 */
export interface MapFocus {
  routeIds: string[];
  /** `network`: the lines in trouble, while the status board is open. */
  kind: 'vehicle' | 'stop' | 'route' | 'trip' | 'network';
}

/**
 * Dims everything that is not about the selection: the network off the
 * focused routes, other vehicles, stops those routes do not call at. With
 * nothing focused, everything is drawn at full strength.
 */
export function syncSelectionFocus(map: maplibregl.Map, focus: MapFocus | null): void {
  const ids = focus && focus.routeIds.length > 0 ? focus.routeIds : null;
  const highlight = ids && (focus?.kind === 'stop' || focus?.kind === 'network') ? ids : [];
  const lineFocus = ids ? onRoutes(ids, 'routeId') : null;
  const stopFocus = ids ? onRoutes(ids, 'routeKey') : null;
  const set = (layer: string, property: string, value: unknown) => {
    if (map.getLayer(layer)) setPaint(map, layer, property, value);
  };

  set('network-line', 'line-opacity', networkOpacity(lineFocus));
  if (map.getLayer('network-highlight')) {
    map.setFilter('network-highlight', ['in', ['get', 'routeId'], ['literal', highlight]]);
  }
  set('network-casing', 'line-opacity', lineFocus ? ['case', lineFocus, 1, 0.25] : 1);

  for (const layer of ['vehicles-dot', 'vehicles-glyph']) {
    set(layer, 'icon-opacity', layer === 'vehicles-glyph' ? glyphOpacity(lineFocus) : vehicleOpacity(lineFocus));
  }
  // The browsed route's vehicles ringed, and drawn over any they overlap.
  if (map.getLayer('vehicles-route')) {
    const ringed = focus?.kind === 'route' && ids ? ids : [];
    map.setFilter('vehicles-route', ['all', NOT_GROUPED, ['in', ['get', 'routeId'], ['literal', ringed]]] as maplibregl.FilterSpecification);
  }
  for (const layer of ['vehicles-dot', 'vehicles-glyph', 'vehicles-label']) {
    if (map.getLayer(layer)) map.setLayoutProperty(layer, 'symbol-sort-key', lineFocus ? ['case', lineFocus, 1, 0] : 0);
  }
  set('vehicles-label', 'text-opacity', vehicleOpacity(lineFocus));
  set('vehicles-label', 'icon-opacity', vehicleOpacity(lineFocus));
  set('vehicle-groups-circle', 'circle-opacity', ids ? 0.35 : 1);
  set('vehicle-groups-circle', 'circle-stroke-opacity', ids ? 0.35 : 1);
  set('vehicle-groups-count', 'text-opacity', ids ? 0.4 : 1);

  const stopOpacity = (base: Expr | number): unknown => (stopFocus ? ['case', stopFocus, base, 0.22] : base);
  set('line-stops-circle', 'circle-opacity', majorFade(stopFocus));
  set('line-stops-circle', 'circle-stroke-opacity', majorFade(stopFocus));
  set('major-stops-circle', 'circle-opacity', stopFocus ? ['case', stopFocus, 1, 0.25] : 1);
  set('major-stops-circle', 'circle-stroke-opacity', stopFocus ? ['case', stopFocus, 1, 0.25] : 1);
  set('major-stops-label', 'text-opacity', stopOpacity(1));
  set('major-stop-badges', 'text-opacity', stopOpacity(1));
  set('major-stop-badges', 'icon-opacity', stopOpacity(1));
}

/** Higher planes are drawn a little smaller: a cue to distance, and to importance. */
const PLANE_ALTITUDE_SCALE: Expr = ['interpolate', ['linear'], ['get', 'alt'], 0, 1, 10000, 0.94, 30000, 0.85];

/**
 * How strongly an aircraft is drawn: low ones near full strength, cruising
 * ones faint, an old position fainter still. `dim` scales the lot — knocked
 * back while the map is about a bus, a stop or a trip — and the chosen
 * plane, if there is one, is always drawn in full.
 */
export function planeOpacity(dim: number, selectedId: string | null): Expr {
  const byHeight: Expr = ['interpolate', ['linear'], ['get', 'alt'], 0, 1 * dim, 8000, 0.95 * dim, 30000, 0.82 * dim];
  const base: Expr = ['case', flag('stale'), ['*', 0.4, byHeight], byHeight];
  return selectedId ? ['case', ['==', ['get', 'id'], selectedId], 1, base] : base;
}

function planeTrailGradient(color: string): Expr {
  return ['interpolate', ['linear'], ['line-progress'], 0, rgbaOf(color, 0), 1, rgbaOf(color, 0.75)];
}

/** A hex colour at an opacity. */
function rgbaOf(hex: string, alpha: number): string {
  const value = Number.parseInt(hex.replace('#', '').padEnd(6, '0').slice(0, 6), 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}

/**
 * Points the aircraft layers at what the rider is looking at: the chosen
 * plane drawn in full with its trail and name, the one under the pointer
 * named, and every plane stepped back while the map is about transit.
 */
export function syncPlaneFocus(
  map: maplibregl.Map,
  options: { transitFocused: boolean; selectedId: string | null; hoveredId: string | null },
): void {
  const { transitFocused, selectedId, hoveredId } = options;
  const dim = transitFocused ? 0.45 : selectedId ? 0.7 : 1;
  if (map.getLayer('planes-icon')) map.setPaintProperty('planes-icon', 'icon-opacity', planeOpacity(dim, selectedId));
  if (map.getLayer('planes-label')) map.setPaintProperty('planes-label', 'text-opacity', planeOpacity(0.9 * dim, null));
  if (map.getLayer('planes-selected')) map.setFilter('planes-selected', ['==', ['get', 'id'], selectedId ?? '']);
  namePlanes(map, selectedId, hoveredId);
}

/**
 * Names the chosen and hovered planes in full, and leaves the rest to the
 * quiet callsign layer. Filters only, so pointing at a plane never disturbs
 * whatever dimming is in force.
 */
export function namePlanes(map: maplibregl.Map, selectedId: string | null, hoveredId: string | null): void {
  if (!map.getLayer('planes-label') || !map.getLayer('planes-label-focus')) return;
  const named = [selectedId, hoveredId].filter((id): id is string => Boolean(id));
  map.setFilter('planes-label', ['!', ['in', ['get', 'id'], ['literal', named]]]);
  map.setFilter('planes-label-focus', ['in', ['get', 'id'], ['literal', named]]);
}

/** Line stops fade in over the first zoom level they are drawn at. */
function majorFade(focus: Expr | null = null): Expr {
  const at = (v: number): Expr | number => (focus ? ['case', focus, v, v * 0.25] : v);
  return ['interpolate', ['linear'], ['zoom'], 9.5, at(0), 10.5, at(1)] as Expr;
}

function glyphOpacity(focus: Expr | null): Expr {
  const at = (v: number): Expr | number => (focus ? ['case', focus, STALE_THEN_LIVE(v, v * 0.6), 0.15] : STALE_THEN_LIVE(v, v * 0.6));
  return ['interpolate', ['linear'], ['zoom'], 12.5, at(0), 13, at(1)] as Expr;
}

/**
 * What journey playback fades, and how far: everything that is not the trip
 * being played. Dimmed rather than hidden, because a route floating in a
 * void reads as a diagram, and the point of playing it on a map is that it
 * is a real place.
 */
export const JOURNEY_DIMMING: { layer: string; property: string; value: number }[] = [
  { layer: 'network-line', property: 'line-opacity', value: 0.05 },
  { layer: 'network-casing', property: 'line-opacity', value: 0 },
  { layer: 'network-highlight', property: 'line-opacity', value: 0.1 },
  { layer: 'route-shape-casing', property: 'line-opacity', value: 0 },
  { layer: 'route-shape-line', property: 'line-opacity', value: 0.08 },
  { layer: 'stops-circle', property: 'circle-opacity', value: 0.1 },
  { layer: 'stops-circle', property: 'circle-stroke-opacity', value: 0.1 },
  { layer: 'line-stops-circle', property: 'circle-opacity', value: 0.1 },
  { layer: 'line-stops-circle', property: 'circle-stroke-opacity', value: 0.1 },
  { layer: 'major-stops-circle', property: 'circle-opacity', value: 0.1 },
  { layer: 'major-stops-circle', property: 'circle-stroke-opacity', value: 0.1 },
  { layer: 'stops-label', property: 'text-opacity', value: 0 },
  { layer: 'major-stops-label', property: 'text-opacity', value: 0 },
  { layer: 'major-stop-badges', property: 'text-opacity', value: 0 },
  { layer: 'major-stop-badges', property: 'icon-opacity', value: 0 },
  { layer: 'stop-badges', property: 'text-opacity', value: 0 },
  { layer: 'stop-badges', property: 'icon-opacity', value: 0 },
  { layer: 'approach-line', property: 'line-opacity', value: 0 },
  { layer: 'approach-line-stopped', property: 'line-opacity', value: 0 },
  { layer: 'approach-ring', property: 'circle-opacity', value: 0 },
  { layer: 'approach-ring', property: 'circle-stroke-opacity', value: 0 },
  { layer: 'vehicles-selected', property: 'circle-opacity', value: 0 },
  { layer: 'vehicles-dot', property: 'icon-opacity', value: 0.16 },
  { layer: 'vehicles-glyph', property: 'icon-opacity', value: 0.1 },
  { layer: 'vehicles-label', property: 'text-opacity', value: 0 },
  { layer: 'vehicles-label', property: 'icon-opacity', value: 0 },
  { layer: 'vehicle-groups-circle', property: 'circle-opacity', value: 0.12 },
  { layer: 'vehicle-groups-circle', property: 'circle-stroke-opacity', value: 0.12 },
  { layer: 'vehicle-groups-count', property: 'text-opacity', value: 0.15 },
  { layer: 'planes-icon', property: 'icon-opacity', value: 0 },
  { layer: 'planes-label', property: 'text-opacity', value: 0 },
  { layer: 'planes-label-focus', property: 'text-opacity', value: 0 },
  { layer: 'planes-selected', property: 'circle-opacity', value: 0 },
  { layer: 'planes-selected', property: 'circle-stroke-opacity', value: 0 },
  { layer: 'plane-trail-line', property: 'line-opacity', value: 0 },
  { layer: 'plane-ahead-line', property: 'line-opacity', value: 0 },
  { layer: 'plane-ahead-end', property: 'circle-opacity', value: 0 },
  { layer: 'plane-ahead-end', property: 'circle-stroke-opacity', value: 0 },
  { layer: 'plane-ahead-label', property: 'text-opacity', value: 0 },
];

const TEXTURE_LAYER = 'ground-texture';
const TEXTURE_IMAGE = 'ground-dots';
/** Pixels between dots in the ground texture, at 1x. */
const TEXTURE_PITCH = 9;

/**
 * A faint dot grid on the bare ground of the street map.
 *
 * Empty land on a flat dark map reads as "nothing loaded"; a fine halftone
 * says "ground, deliberately quiet", the way a printed network map screens
 * its background. It sits under parks, water and roads, so it only shows
 * where there is nothing else, and it is far too faint to compete with a line.
 */
export function syncGroundTexture(map: maplibregl.Map, p: Palette): void {
  // Only the app's own street map has a plain ground to texture, and once
  // is enough: a new style (which a theme change brings) arrives without it.
  if (map.getLayer(TEXTURE_LAYER) || !map.getLayer('landcover') || !map.getLayer('background')) return;
  const ratio = 2;
  const size = TEXTURE_PITCH * ratio;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.fillStyle = p.textureDot;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, 0.75 * ratio, 0, Math.PI * 2);
  ctx.fill();
  const image = ctx.getImageData(0, 0, size, size);
  if (map.hasImage(TEXTURE_IMAGE)) map.updateImage(TEXTURE_IMAGE, image);
  else map.addImage(TEXTURE_IMAGE, image, { pixelRatio: ratio });
  map.addLayer(
    { id: TEXTURE_LAYER, type: 'background', paint: { 'background-pattern': TEXTURE_IMAGE } },
    'landcover',
  );
}
