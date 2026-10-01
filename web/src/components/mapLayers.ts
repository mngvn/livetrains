import type maplibregl from 'maplibre-gl';
import type { Palette } from '../lib/palette.ts';
import { MODE_TO_GLYPH, VEHICLE_ICON } from './mapIcons.ts';

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

/** Map text, in the faces the glyph server actually has. */
export const FONT_REGULAR = ['Noto Sans Regular'];
export const FONT_BOLD = ['Noto Sans Bold'];

/** Below this zoom, vehicles that overlap on screen gather into counted discs. */
export const GROUP_BELOW_ZOOM = 12;

/** Properties that are absent mean "no", not "error". */
const flag = (name: string): Expr => ['boolean', ['get', name], false];
const NOT_GROUPED: Expr = ['!', flag('grouped')];

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

function beamOpacity(focus: Expr | null): Expr {
  // Gone well before the zoom at which you would inspect a single vehicle.
  const at = (v: number): Expr | number => (focus ? ['case', focus, v, 0] : v);
  return ['interpolate', ['linear'], ['zoom'], 8, at(0.5), 10.5, at(0.36), 12, at(0.16), 13.5, at(0)] as Expr;
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
export function ensureLayers(map: maplibregl.Map, p: Palette, showBeams: boolean): boolean {
  if (map.getLayer('vehicles-hit')) return false;

  for (const id of [
    'network', 'itinerary', 'itinerary-points', 'stops', 'major-stops', 'vehicles', 'vehicle-groups',
    'endpoints', 'journey-trail', 'journey-traveller', 'vehicle-trip', 'vehicle-trip-stops',
  ]) {
    if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: EMPTY });
  }
  // Line metrics are what let a line be drawn on from one end, or fade.
  for (const id of ['route-shape', 'vehicle-trip-full', 'vehicle-trail']) {
    if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: EMPTY, lineMetrics: true });
  }

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
  map.addLayer({
    id: 'major-stops-circle',
    type: 'circle',
    source: 'major-stops',
    minzoom: 9.5,
    paint: {
      'circle-radius': MAJOR_STOP_RADIUS,
      'circle-color': p.stopFill,
      'circle-stroke-color': p.stopStroke,
      'circle-stroke-width': MAJOR_STOP_STROKE,
      'circle-opacity': ['interpolate', ['linear'], ['zoom'], 9.5, 0, 10.5, 1],
      'circle-stroke-opacity': ['interpolate', ['linear'], ['zoom'], 9.5, 0, 10.5, 1],
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
  // Which routes call here, on a plate above the stop with the name below it,
  // so a stop can be read without tapping it and neither crowds the other.
  for (const [id, source, minzoom, filter] of [
    ['major-stop-badges', 'major-stops', 14.5, null],
    ['stop-badges', 'stops', 16.5, ['!', flag('major')]],
  ] as const) {
    map.addLayer({
      id,
      type: 'symbol',
      source,
      minzoom,
      ...(filter ? { filter: filter as Expr } : {}),
      layout: {
        'text-field': ['get', 'badges'],
        'text-font': FONT_BOLD,
        'text-size': 9.5,
        'text-letter-spacing': 0.04,
        'text-offset': [0, -1.05],
        'text-anchor': 'bottom',
        'icon-image': 'badge',
        'icon-text-fit': 'both',
        'icon-text-fit-padding': [1, 4, 1, 4],
      },
      paint: { 'text-color': p.badgeText, 'icon-color': p.badge, 'icon-halo-color': p.rule, 'icon-halo-width': 1 },
    });
  }

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

  // --- Vehicles -------------------------------------------------------------------
  // Beams first, so every marker draws over them. A finding aid for metro
  // scale, gone by the time a vehicle is big enough to read.
  map.addLayer({
    id: 'vehicles-beam',
    type: 'symbol',
    source: 'vehicles',
    filter: ['all', ['!', flag('stale')], NOT_GROUPED],
    layout: {
      'icon-image': 'vehicle-beam',
      visibility: showBeams ? 'visible' : 'none',
      'icon-anchor': 'bottom',
      'icon-size': ['interpolate', ['linear'], ['zoom'], 8, 0.95, 11, 0.7, 13, 0.42, 14, 0.3],
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
    paint: { 'icon-color': ['get', 'color'], 'icon-opacity': beamOpacity(null) },
  });

  // Groups: a disc with a count, drawn where vehicles pile up on screen.
  map.addLayer({
    id: 'vehicle-groups-circle',
    type: 'circle',
    source: 'vehicle-groups',
    paint: {
      'circle-color': p.surface2,
      'circle-radius': ['step', ['get', 'count'], 11, 10, 14, 25, 17, 60, 21, 150, 26],
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
      'text-size': 11.5,
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
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 13, 16, 22],
      'circle-color': ['get', 'color'],
      'circle-opacity': 0.28,
      'circle-stroke-color': ['get', 'color'],
      'circle-stroke-width': 1.5,
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
      'icon-size': ['interpolate', ['linear'], ['zoom'], 9, 0.46, 13, 0.9, 16, 1.15],
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
    if (map.getLayer(layer)) map.setPaintProperty(layer, property, value);
  };
  set('network-casing', 'line-color', p.casing);
  set('vehicle-trip-casing', 'line-color', p.casing);
  set('itinerary-casing', 'line-color', p.casing);
  set('route-shape-casing', 'line-gradient', solid(p.casing));
  for (const layer of ['stops-circle', 'major-stops-circle']) {
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
  set('vehicle-groups-circle', 'circle-color', p.surface2);
  set('vehicle-groups-circle', 'circle-stroke-color', [
    'case',
    ['>', ['/', ['get', 'rail'], ['get', 'count']], 0.5],
    p.text,
    p.muted,
  ]);
  set('vehicle-groups-count', 'text-color', p.text);
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
    if (map.getLayer(layer)) map.setPaintProperty(layer, property, value);
  };

  set('network-line', 'line-opacity', networkOpacity(lineFocus));
  if (map.getLayer('network-highlight')) {
    map.setFilter('network-highlight', ['in', ['get', 'routeId'], ['literal', highlight]]);
  }
  set('network-casing', 'line-opacity', lineFocus ? ['case', lineFocus, 1, 0.25] : 1);

  for (const layer of ['vehicles-dot', 'vehicles-glyph']) {
    set(layer, 'icon-opacity', layer === 'vehicles-glyph' ? glyphOpacity(lineFocus) : vehicleOpacity(lineFocus));
  }
  set('vehicles-label', 'text-opacity', vehicleOpacity(lineFocus));
  set('vehicles-label', 'icon-opacity', vehicleOpacity(lineFocus));
  set('vehicles-beam', 'icon-opacity', beamOpacity(lineFocus));
  set('vehicle-groups-circle', 'circle-opacity', ids ? 0.35 : 1);
  set('vehicle-groups-circle', 'circle-stroke-opacity', ids ? 0.35 : 1);
  set('vehicle-groups-count', 'text-opacity', ids ? 0.4 : 1);

  const stopOpacity = (base: Expr | number): unknown => (stopFocus ? ['case', stopFocus, base, 0.22] : base);
  set('major-stops-circle', 'circle-opacity', stopFocus ? ['case', stopFocus, 1, 0.25] : majorFade());
  set('major-stops-circle', 'circle-stroke-opacity', stopFocus ? ['case', stopFocus, 1, 0.25] : majorFade());
  set('major-stops-label', 'text-opacity', stopOpacity(1));
  set('major-stop-badges', 'text-opacity', stopOpacity(1));
  set('major-stop-badges', 'icon-opacity', stopOpacity(1));
}

function majorFade(): Expr {
  return ['interpolate', ['linear'], ['zoom'], 9.5, 0, 10.5, 1];
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
  { layer: 'major-stops-circle', property: 'circle-opacity', value: 0.1 },
  { layer: 'major-stops-circle', property: 'circle-stroke-opacity', value: 0.1 },
  { layer: 'stops-label', property: 'text-opacity', value: 0 },
  { layer: 'major-stops-label', property: 'text-opacity', value: 0 },
  { layer: 'major-stop-badges', property: 'text-opacity', value: 0 },
  { layer: 'major-stop-badges', property: 'icon-opacity', value: 0 },
  { layer: 'stop-badges', property: 'text-opacity', value: 0 },
  { layer: 'stop-badges', property: 'icon-opacity', value: 0 },
  { layer: 'vehicles-beam', property: 'icon-opacity', value: 0 },
  { layer: 'vehicles-selected', property: 'circle-opacity', value: 0 },
  { layer: 'vehicles-dot', property: 'icon-opacity', value: 0.16 },
  { layer: 'vehicles-glyph', property: 'icon-opacity', value: 0.1 },
  { layer: 'vehicles-label', property: 'text-opacity', value: 0 },
  { layer: 'vehicles-label', property: 'icon-opacity', value: 0 },
  { layer: 'vehicle-groups-circle', property: 'circle-opacity', value: 0.12 },
  { layer: 'vehicle-groups-circle', property: 'circle-stroke-opacity', value: 0.12 },
  { layer: 'vehicle-groups-count', property: 'text-opacity', value: 0.15 },
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
