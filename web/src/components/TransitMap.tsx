import { useCallback, useEffect, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import type { LngLatBoundsLike, MapGeoJSONFeature } from 'maplibre-gl';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import type { AgencyInfo, Itinerary, RouteNetwork, RouteSummary, StopSummary, VehicleTrip } from '../lib/api.ts';
import { approachFeatures, findApproaches, type ApproachStop } from '../lib/approach.ts';
import { splitLineAt } from '../lib/geometry.ts';
import type { TrackedVehicle, VehicleTracker } from '../lib/vehicleTracker.ts';
import type { PlaneTracker, TrackedPlane } from '../lib/planeTracker.ts';
import { planeHeight, planeLabel, planeShape } from '../lib/planeInfo.ts';
import { deadReckon } from '../lib/planeTracker.ts';
import { distanceKm, greatCircle } from '../lib/planeBound.ts';
import { plateLabel, readableTextColor } from '../lib/format.ts';
import { groupVehicles as groupOnScreen, type GroupInput, type Grouping } from '../lib/grouping.ts';
import { PALETTES, type Palette } from '../lib/palette.ts';
import { escapeHtml } from '../lib/safeUrl.ts';
import { registerVehicleIcons } from './mapIcons.ts';
import {
  DARK_FALLBACK_STYLE,
  FALLBACK_STYLE,
  VECTOR_SOURCE_ID,
  isDarkMap,
  styleFor,
  type BasemapId,
} from './basemaps.ts';
import {
  APPROACH_FROM_ZOOM,
  EMPTY,
  GROUND_PLANES_FROM_ZOOM,
  GROUP_BELOW_ZOOM,
  JOURNEY_DIMMING,
  ensureLayers,
  getPaint,
  revealLines,
  setPaint,
  stopBadgeFilter,
  syncGroundTexture,
  namePlanes,
  syncOverlayTheme,
  syncPlaneFocus,
  syncSelectionFocus,
  type MapFocus,
} from './mapLayers.ts';
import type { JourneyPlayback } from '../lib/journeyPlayback.ts';
import { trailAt } from '../lib/journey.ts';

/**
 * MapLibre 6 ships its tile worker as a separate module and finds it next to
 * its own file. Bundled, its own file is a hashed chunk with no worker beside
 * it, so the worker is built as an entry of its own and pointed at here,
 * before any map exists.
 */
maplibregl.setWorkerUrl(maplibreWorkerUrl);

/**
 * The live map.
 *
 * MapLibre GL with open vector tiles, so there is no API key to obtain, no
 * billing account, and no usage ceiling. Vehicles, stops and the planned route
 * are drawn as GeoJSON sources updated imperatively — React renders the chrome
 * around the map, never the map contents, because the vehicle layer updates on
 * every animation frame. What is drawn, and how, lives in `mapLayers.ts`.
 */

interface Props {
  agency: AgencyInfo;
  tracker: VehicleTracker;
  /** Every stop in view, once the map is close enough for them to matter. */
  stops: StopSummary[];
  /** Stations, METRO stops and the busiest corners, network-wide. */
  majorStops: StopSummary[];
  itinerary: Itinerary | null;
  /** Route shape to highlight when browsing a route. */
  routeShape: { geometry: [number, number][]; color: string } | null;
  /** Every route's shape: the network the vehicles run on. */
  network: RouteNetwork | null;
  selectedVehicleId: string | null;
  origin: { lat: number; lon: number } | null;
  destination: { lat: number; lon: number } | null;
  onSelectVehicle: (id: string) => void;
  onSelectStop: (stopId: string) => void;
  /** A tap on the map that hit nothing: a place to pick, or a click away. */
  onMapClick: (lat: number, lon: number) => void;
  onViewportChange: (bbox: [number, number, number, number]) => void;
  /** Whether vehicles throw their colour beams. */
  showBeams: boolean;
  /** Whether vehicles gather into counted groups when zoomed out. */
  groupVehicles: boolean;
  /** Which background the map wears. */
  basemap: BasemapId;
  /** Whether the app is in its dark theme; the street map follows it. */
  dark: boolean;
  /** Tilt the camera and extrude buildings. */
  three: boolean;
  /** Drives the animated traveller, when a journey is being played. */
  playback: JourneyPlayback;
  /** Dim everything that is not the journey being played. */
  focusJourney: boolean;
  /**
   * The routes the rider is looking at — a selected vehicle's, the lines
   * through a selected stop, a browsed route. Everything else steps back.
   */
  focus: MapFocus | null;
  /** The selected vehicle's trip, outlined with the road ahead in bold. */
  vehicleTrip: VehicleTrip | null;
  /** Where that vehicle last reported, to split behind from ahead. */
  vehiclePosition: [number, number] | null;
  /**
   * Somewhere to take the camera: a stop found by search, a shared link, the
   * whole network. A new object is a new request, so asking twice works.
   */
  cameraTarget: CameraTarget | null;
  /**
   * How much of the map the app's own panels cover, in pixels. The camera
   * centres, flies and fits within what is left, so a stop found by search
   * lands where it can be seen rather than behind the bottom sheet.
   */
  padding: MapPadding;
  /** The selected stop, marked with a pin that stays on it as the map moves. */
  pin: { id: string; name: string; lat: number; lon: number } | null;
  /**
   * The live feed has gone quiet for long enough that no position on the
   * map can be called live. Every vehicle is drawn greyed until it recovers.
   */
  feedStale: boolean;
  /** The vehicle you are riding: the camera keeps it in view. */
  followVehicleId: string | null;
  /** Everywhere reachable from a stop, as banded grid cells, while shown. */
  isochrone: GeoJSON.FeatureCollection | null;
  /** Aircraft overhead, moved every frame like the vehicles. */
  planeTracker: PlaneTracker;
  selectedPlaneId: string | null;
  onSelectPlane: (id: string) => void;
  /** Credit for the aircraft feed in the map's attribution, while planes are shown. */
  planeAttribution: string | null;
  /** Where the chosen plane is going, drawn ahead of it. */
  planeBound: { kind: 'destination' | 'landing' | 'toward'; label: string; lat: number; lon: number } | null;
}

export interface MapPadding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export type CameraTarget =
  | {
      lon: number;
      lat: number;
      /** The least zoom to arrive at; a closer view is kept. */
      zoom: number;
    }
  | {
      /** Fit this box, [west, south, east, north]: the whole network, say. */
      bounds: [number, number, number, number];
    };

/**
 * Camera tilt in 3D mode.
 *
 * Far enough over to read building height and give the vehicle beams
 * somewhere to stand, short of the angle where the far half of the screen is
 * horizon and the near half is one intersection.
 */
const PITCH_3D = 55;

/**
 * How often the camera re-centres on a travelling journey.
 *
 * Each follow is an ease lasting exactly this long, so they butt up against
 * one another and read as a single continuous glide.
 */
const FOLLOW_INTERVAL_MS = 400;

/** The extruded-buildings layer, added and removed as 3D is toggled. */
const BUILDINGS_LAYER = 'buildings-3d';

/** A vehicle id no feed can produce, so the selection filter matches nothing. */
const NO_SELECTION = '\u0000no-selection';

/**
 * How often vehicle groups are re-formed while the map is still.
 *
 * Only membership is decided at this rate. Vehicles outside a group are drawn
 * from the per-frame source and glide; only the counted discs step, and at
 * the zooms where they are shown half a second's travel is under a pixel.
 */
const GROUP_REFRESH_MS = 500;

/** While the camera moves, groups follow it at about this rate. */
const GROUP_REFRESH_MOVING_MS = 120;

/** Vehicles closer together on screen than this gather into a group. */
const GROUP_RADIUS_PX = 26;

/** While riding, the camera re-centres on the vehicle this often, gliding between. */
const FOLLOW_RIDE_MS = 1_500;

/** After the rider moves the map, following waits this long before resuming. */
const FOLLOW_PAUSE_MS = 10_000;

/** How often the selected vehicle's trail is redrawn. */
const TRAIL_REFRESH_MS = 1_000;

/** How long a selection's outline takes to draw on, end to end. */
const ROUTE_REVEAL_MS = 700;
const TRIP_REVEAL_MS = 900;

/** A tap this close to a plane's centre is a tap on the plane, whatever is beside it. */
const PLANE_TAP_PX = 10;

/** Modes drawn as trains, matching MODE_TO_ICON. */
const RAIL_MODES = new Set(['rail', 'tram', 'metro', 'funicular', 'cable']);

/** The pin that marks the selected stop: a drop shape with a ring at its heart. */
function createPinElement(): HTMLElement {
  const element = document.createElement('div');
  element.className = 'stop-pin';
  element.setAttribute('role', 'img');
  element.innerHTML =
    '<svg viewBox="0 0 32 42" width="32" height="42" aria-hidden="true">' +
    '<path d="M16 2C8.3 2 3 7.7 3 15c0 9.3 10.6 20.4 12.2 22a1.1 1.1 0 0 0 1.6 0C18.4 35.4 29 24.3 29 15 29 7.7 23.7 2 16 2Z" class="stop-pin__body"/>' +
    '<circle cx="16" cy="15" r="5.2" class="stop-pin__eye"/>' +
    '</svg>';
  return element;
}

/** A route colour (hex, with or without '#') at an opacity, for gradients. */
function rgba(hex: string, alpha: number): string {
  const value = Number.parseInt(hex.replace('#', '').padEnd(6, '0').slice(0, 6), 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}

/**
 * A route colour drained towards grey, for a position that is no longer live.
 *
 * Fading alone is not enough: a faded red bus on a dark map still reads as a
 * red bus, just a dim one. Taking the colour out is what says "not now".
 */
function desaturate(hex: string): string {
  const value = Number.parseInt(hex.replace('#', '').padEnd(6, '0').slice(0, 6), 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  const grey = 0.3 * r + 0.59 * g + 0.11 * b;
  // Mostly grey, a trace of the route left so it can still be told apart.
  const mix = (c: number) => Math.round(grey * 0.82 + c * 0.18 + (128 - grey) * 0.25);
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}

function paletteFor(basemap: BasemapId, dark: boolean): Palette {
  return PALETTES[isDarkMap(basemap, dark) ? 'dark' : 'light'];
}

/** The routes a stop serves, as ",A,B," so one can be found by substring. */
function routeKey(routes: RouteSummary[] | undefined): string {
  return `,${(routes ?? []).map((route) => route.id).join(',')},`;
}

/** The route numbers printed under a stop, longest lists cut short. */
function badgeText(routes: RouteSummary[] | undefined): string {
  const names = (routes ?? []).map((route) => plateLabel(route.shortName || route.id).toUpperCase());
  if (names.length === 0) return '';
  const shown = names.slice(0, 6);
  return shown.join('  ') + (names.length > shown.length ? `  +${names.length - shown.length}` : '');
}

function stopFeatures(stops: StopSummary[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: stops.map((stop) => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [stop.lon, stop.lat] },
      properties: {
        id: stop.id,
        name: stop.name,
        major: stop.major === true,
        interchange: stop.interchange === true,
        onLine: stop.onLine === true,
        routeKey: routeKey(stop.routes),
        badges: badgeText(stop.routes),
      },
    })),
  };
}

/**
 * A map button that brings the whole network back into view: after zooming
 * into a corner of the city, one press and you are looking at the system
 * again. Square-on and north-up too, since that is what "the network" looks
 * like on every printed map of it.
 */
class NetworkViewControl implements maplibregl.IControl {
  private container: HTMLElement | null = null;
  constructor(private readonly bounds: () => [number, number, number, number]) {}

  onAdd(map: maplibregl.Map): HTMLElement {
    const container = document.createElement('div');
    container.className = 'maplibregl-ctrl maplibregl-ctrl-group';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'network-view-button';
    button.title = 'Show the whole network';
    button.setAttribute('aria-label', 'Show the whole network');
    button.innerHTML =
      '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">' +
      '<path d="M3 7V3h4M13 3h4v4M17 13v4h-4M7 17H3v-4" fill="none" stroke="currentColor" stroke-width="1.8"/>' +
      '<path d="M6 13l3.5-3.5 2 2L14.5 7" fill="none" stroke="currentColor" stroke-width="1.8"/>' +
      '<circle cx="9.5" cy="9.5" r="1.4" fill="currentColor"/><circle cx="11.5" cy="11.5" r="1.4" fill="currentColor"/>' +
      '</svg>';
    button.addEventListener('click', () => {
      map.fitBounds(this.bounds() as LngLatBoundsLike, { padding: 40, bearing: 0, duration: 700 });
    });
    container.appendChild(button);
    this.container = container;
    return container;
  }

  onRemove(): void {
    this.container?.remove();
    this.container = null;
  }
}

/** Layers a tap can land on, most specific first. */
const PICKABLE_LAYERS = [
  'vehicles-hit',
  'vehicle-groups-circle',
  // Beneath the vehicles, as they are drawn: where a plane passes over a
  // bus the bus is what a tap means, but anywhere else the plane is its own
  // thing to tap.
  'planes-hit',
  'itinerary-stops',
  'line-stops-circle',
  'major-stops-circle',
  'stops-circle',
  'vehicle-trip-stops',
];

export function TransitMap({
  agency,
  tracker,
  stops,
  majorStops,
  itinerary,
  routeShape,
  network,
  selectedVehicleId,
  origin,
  destination,
  onSelectVehicle,
  onSelectStop,
  onMapClick,
  onViewportChange,
  showBeams,
  groupVehicles,
  basemap,
  dark,
  three,
  playback,
  focusJourney,
  focus,
  vehicleTrip,
  vehiclePosition,
  cameraTarget,
  padding,
  pin,
  feedStale,
  followVehicleId,
  isochrone,
  planeTracker,
  selectedPlaneId,
  onSelectPlane,
  planeAttribution,
  planeBound,
}: Props) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const ready = useRef(false);
  /**
   * Bumped whenever the sources and layers are (re)created.
   *
   * `ready` is a ref, so flipping it does not re-run the effects that push
   * data into the map. Without a real state change, anything that loaded
   * before the style did — or anything held when a style swap dropped every
   * source — would simply never be drawn. This is what makes those effects
   * run again at the right moment.
   */
  const [styleEpoch, setStyleEpoch] = useState(0);
  /** Guards against a fallback loop if the fallback style itself errors. */
  const usedFallback = useRef(false);
  /**
   * Current props, readable from the map's own listeners and the frame loop,
   * which are attached once and never see later props.
   */
  const beamsWanted = useRef(showBeams);
  beamsWanted.current = showBeams;
  const groupWanted = useRef(groupVehicles);
  groupWanted.current = groupVehicles;
  const selectedRef = useRef(selectedVehicleId);
  selectedRef.current = selectedVehicleId;
  const focusRef = useRef<Set<string>>(new Set());
  focusRef.current = new Set(focus?.routeIds ?? []);
  const approachStopsRef = useRef<Map<string, ApproachStop>>(new Map());
  const feedStaleRef = useRef(feedStale);
  feedStaleRef.current = feedStale;
  const followRef = useRef(followVehicleId);
  followRef.current = followVehicleId;
  /** When the rider last moved the map themselves; following waits for them. */
  const lastTouched = useRef(0);
  const paletteRef = useRef(paletteFor(basemap, dark));
  paletteRef.current = paletteFor(basemap, dark);
  const threeWanted = useRef(three);
  threeWanted.current = three;
  const darkWanted = useRef(dark);
  darkWanted.current = dark;
  /** The view mode at construction, so the first frame is already right. */
  const initial = useRef({ basemap, three, dark });
  /** The style last handed to MapLibre, so an unchanged one is not reloaded. */
  const appliedStyle = useRef(styleFor(basemap, dark));
  /** Set by camera movement, so groups follow a zoom without waiting. */
  const cameraMoved = useRef(true);
  // Handlers change on every render; hold them in a ref so the map's own
  // listeners can stay attached for the life of the component.
  const handlers = useRef({ onSelectVehicle, onSelectStop, onSelectPlane, onMapClick, onViewportChange });
  handlers.current = { onSelectVehicle, onSelectStop, onSelectPlane, onMapClick, onViewportChange };
  const selectedPlaneRef = useRef(selectedPlaneId);
  selectedPlaneRef.current = selectedPlaneId;
  const planeBoundRef = useRef(planeBound);
  planeBoundRef.current = planeBound;
  /** The plane under the pointer, named on the map while it is there. */
  const hoveredPlane = useRef<string | null>(null);
  const transitFocused = Boolean(focus && focus.routeIds.length > 0);
  /** A journey is playing: the sky is cleared until it ends. */
  const playingRef = useRef(focusJourney);
  playingRef.current = focusJourney;
  const attributionControl = useRef<maplibregl.AttributionControl | null>(null);

  const setData = useCallback((id: string, data: GeoJSON.FeatureCollection) => {
    const source = map.current?.getSource(id) as maplibregl.GeoJSONSource | undefined;
    source?.setData(data);
  }, []);

  // --- Map construction (once) ---------------------------------------------
  useEffect(() => {
    if (!container.current || map.current) return;

    const instance = new maplibregl.Map({
      container: container.current,
      style: styleFor(initial.current.basemap, initial.current.dark),
      bounds: agency.bbox as LngLatBoundsLike,
      fitBoundsOptions: { padding: 40 },
      attributionControl: false,
      pitch: initial.current.three ? PITCH_3D : 0,
      // 2D is north-up and flat; rotation is enabled only in 3D, where being
      // able to turn the city round is the whole point of the tilt.
      pitchWithRotate: initial.current.three,
      dragRotate: initial.current.three,
      // Labels and lines stay crisp through a zoom rather than snapping
      // between levels.
      fadeDuration: 180,
    });
    map.current = instance;
    // For anyone poking at the map from the console, and the browser tests.
    (window as unknown as { __livetrainsMap?: maplibregl.Map }).__livetrainsMap = instance;

    instance.addControl(new NetworkViewControl(() => agency.bbox), 'bottom-right');
    instance.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    // MapLibre renders attribution as HTML; the agency's name is text.
    attributionControl.current = new maplibregl.AttributionControl({
      compact: true,
      customAttribution: escapeHtml(agency.name),
    });
    instance.addControl(attributionControl.current, 'bottom-left');
    instance.addControl(
      new maplibregl.GeolocateControl({
        positionOptions: { enableHighAccuracy: true },
        trackUserLocation: true,
        showUserLocation: true,
      }),
      'bottom-right',
    );

    const emitViewport = () => {
      const bounds = instance.getBounds();
      handlers.current.onViewportChange([
        bounds.getWest(),
        bounds.getSouth(),
        bounds.getEast(),
        bounds.getNorth(),
      ]);
    };

    /**
     * Puts this app's sources, layers and images back on the map.
     *
     * `setStyle` drops every one of them, so this runs after each style as
     * well as after the first.
     */
    const rebuild = () => {
      // Nothing can be added until the style spec has been applied. Note the
      // test is *not* `isStyleLoaded()`: that also waits for every source's
      // tiles, so on a slow basemap — aerial imagery especially — it can stay
      // false for many seconds after the style itself is ready, and a source
      // that never loads holds it false forever. `getStyle()` starts
      // answering as soon as the spec is in place, which is exactly when
      // layers can be added.
      if (!instance.getStyle()) return;
      try {
        registerVehicleIcons(instance);
        if (ensureLayers(instance, paletteRef.current, beamsWanted.current)) setStyleEpoch((epoch) => epoch + 1);
        syncGroundTexture(instance, paletteRef.current);
        syncBuildings(instance, threeWanted.current, paletteRef.current);
      } catch (err) {
        // The style was not as ready as it looked; `styledata` fires again.
        console.warn('livetrains: deferring layer rebuild', err);
        return;
      }
      ready.current = true;
      // `load` never fires when the first style fails, so this is also the only
      // chance to report the initial viewport — without it the stops-in-view
      // queries would never run.
      emitViewport();
    };

    instance.on('load', rebuild);
    instance.on('styledata', rebuild);

    instance.on('error', (event) => {
      const failure = event as { error?: { message?: string }; sourceId?: string };
      // MapLibre tags source and tile failures with the source they came from.
      // Those are local and transient — one aerial tile that will not load, a
      // vector source that has no buildings here — and recovering from them by
      // throwing the whole style away would turn a missing tile into a missing
      // map. Only a style document that cannot be fetched leaves nothing to
      // draw, and that is the one worth falling back from.
      if (failure.sourceId !== undefined) return;
      const message = String(failure.error?.message ?? '');
      if (!usedFallback.current && /style|Failed to fetch/i.test(message)) {
        usedFallback.current = true;
        console.warn('livetrains: basemap unavailable, falling back to a plain background');
        instance.setStyle(darkWanted.current ? DARK_FALLBACK_STYLE : FALLBACK_STYLE);
      }
    });

    instance.on('moveend', emitViewport);
    // Only real gestures count: the follow camera's own moves have no event.
    for (const type of ['dragstart', 'zoomstart', 'rotatestart', 'pitchstart'] as const) {
      instance.on(type, (event: { originalEvent?: Event }) => {
        if (event.originalEvent) lastTouched.current = performance.now();
      });
    }
    instance.on('move', () => {
      cameraMoved.current = true;
    });

    // --- Interaction ---
    const pickFeature = (point: maplibregl.Point): MapGeoJSONFeature | null => {
      const layers = PICKABLE_LAYERS.filter((id) => instance.getLayer(id));
      if (layers.length === 0) return null;
      // A few pixels of slack: stop rings are small, and fingers are not.
      const slack = 5;
      const hits = instance.queryRenderedFeatures(
        [
          [point.x - slack, point.y - slack],
          [point.x + slack, point.y + slack],
        ],
        { layers },
      );
      if (hits.length === 0) return null;
      // Vehicles over groups over stops, whatever order they were drawn in.
      hits.sort((a, b) => PICKABLE_LAYERS.indexOf(a.layer.id) - PICKABLE_LAYERS.indexOf(b.layer.id));
      // Except that a tap right on a plane means the plane. A bus's hit
      // target is generous, and planes cross busy streets: without this, a
      // plane over Lake Street could never be tapped at all.
      const plane = hits.find((hit) => hit.layer.id === 'planes-hit');
      if (plane && plane !== hits[0]) {
        const away = (hit: MapGeoJSONFeature) => {
          const at = instance.project((hit.geometry as GeoJSON.Point).coordinates as [number, number]);
          return Math.hypot(at.x - point.x, at.y - point.y);
        };
        if (away(plane) <= PLANE_TAP_PX && away(plane) < away(hits[0])) return plane;
      }
      return hits[0];
    };

    instance.on('click', (event) => {
      const feature = pickFeature(event.point);
      if (!feature) {
        handlers.current.onMapClick(event.lngLat.lat, event.lngLat.lng);
        return;
      }
      const layer = feature.layer.id;
      if (layer === 'vehicle-groups-circle') {
        // Open the group up: two levels closer is always enough to separate
        // vehicles that were within a few pixels of each other.
        const center = (feature.geometry as GeoJSON.Point).coordinates as [number, number];
        instance.easeTo({ center, zoom: Math.min(GROUP_BELOW_ZOOM + 0.5, instance.getZoom() + 2), duration: 450 });
      } else if (layer === 'vehicles-hit') {
        handlers.current.onSelectVehicle(String(feature.properties?.id ?? ''));
      } else if (layer === 'planes-hit') {
        handlers.current.onSelectPlane(String(feature.properties?.id ?? ''));
      } else {
        handlers.current.onSelectStop(String(feature.properties?.id ?? ''));
      }
    });

    instance.on('mousemove', (event) => {
      const feature = pickFeature(event.point);
      instance.getCanvas().style.cursor = feature ? 'pointer' : '';
      // A plane under the pointer says what it is, without a click.
      const plane = feature?.layer.id === 'planes-hit' ? String(feature.properties?.id ?? '') : null;
      if (plane !== hoveredPlane.current) {
        hoveredPlane.current = plane;
        namePlanes(instance, selectedPlaneRef.current, plane);
      }
    });

    return () => {
      instance.remove();
      map.current = null;
      ready.current = false;
      // Let go of the console handle too, or a removed map (and its GL
      // context's worth of buffers) stays reachable after a remount.
      const debug = window as unknown as { __livetrainsMap?: maplibregl.Map };
      if (debug.__livetrainsMap === instance) delete debug.__livetrainsMap;
    };
    // Rebuilding the map on agency change is correct — it is a different city.
  }, [agency.bbox, agency.name]);

  // --- Live vehicles, updated per animation frame ---------------------------
  useEffect(() => {
    let lastGrouped = 0;
    let lastTrail = 0;
    let lastFollow = 0;
    let grouping: Grouping | null = null;
    /** Text colour per route colour, worked out once rather than per frame. */
    const textColors = new Map<string, string>();
    const greyed = new Map<string, string>();
    const textOn = (color: string) => {
      let text = textColors.get(color);
      if (!text) textColors.set(color, (text = readableTextColor(color)));
      return text;
    };
    const grey = (color: string) => {
      let value = greyed.get(color);
      if (!value) greyed.set(color, (value = desaturate(color)));
      return value;
    };

    let approachesDrawn = false;
    return tracker.onFrame((vehicles: TrackedVehicle[]) => {
      const instance = map.current;
      if (!ready.current || !instance) return;
      const now = performance.now();

      // Which vehicles are folded into a group. Decided a couple of times a
      // second, or as the camera moves; the vehicles themselves move every
      // frame regardless.
      const wantGroups = groupWanted.current && instance.getZoom() < GROUP_BELOW_ZOOM;
      if (!wantGroups) {
        if (grouping) {
          grouping = null;
          setData('vehicle-groups', EMPTY);
        }
      } else if (now - lastGrouped >= (cameraMoved.current ? GROUP_REFRESH_MOVING_MS : GROUP_REFRESH_MS)) {
        lastGrouped = now;
        cameraMoved.current = false;
        const selected = selectedRef.current;
        const focus = focusRef.current;
        const inputs: GroupInput[] = [];
        for (const v of vehicles) {
          // What the rider is looking at is never folded away into a count.
          if (v.id === selected || (v.routeId !== undefined && focus.has(v.routeId))) continue;
          const point = instance.project([v.displayLon, v.displayLat]);
          inputs.push({ id: v.id, x: point.x, y: point.y, lon: v.displayLon, lat: v.displayLat, rail: RAIL_MODES.has(v.mode) });
        }
        grouping = groupOnScreen(inputs, GROUP_RADIUS_PX);
        setData('vehicle-groups', {
          type: 'FeatureCollection',
          features: grouping.groups.map((group) => ({
            type: 'Feature' as const,
            geometry: { type: 'Point' as const, coordinates: [group.lon, group.lat] },
            properties: { count: group.count, rail: group.rail },
          })),
        });
      }

      const feedQuiet = feedStaleRef.current;
      setData('vehicles', {
        type: 'FeatureCollection',
        features: vehicles.map((v) => {
          const stale = v.stale || feedQuiet;
          const color = `#${v.color}`;
          return {
            type: 'Feature' as const,
            geometry: { type: 'Point' as const, coordinates: [v.displayLon, v.displayLat] },
            properties: {
              id: v.id,
              routeId: v.routeId ?? '',
              color: stale ? grey(color) : color,
              textColor: textOn(v.color),
              label: v.routeShortName ? plateLabel(v.routeShortName) : '',
              bearing: v.displayBearing,
              mode: v.mode,
              // Only draw a heading when the feed actually reported one; an
              // arrow pointing north on a vehicle of unknown heading is a
              // confident lie.
              hasHeading: v.bearing !== undefined,
              stale,
              grouped: grouping?.grouped.has(v.id) ?? false,
            },
          };
        }),
      });

      // Vehicles pulling in to a stop, linked to it — only zoomed in, where a
      // street's worth of stops is on screen and the links can be told apart.
      if (instance.getZoom() >= APPROACH_FROM_ZOOM) {
        const bounds = instance.getBounds();
        const inView = vehicles.filter((v) => bounds.contains([v.displayLon, v.displayLat]));
        const { lines, rings } = approachFeatures(
          findApproaches(
            inView.map((v) => ({
              id: v.id,
              routeId: v.routeId,
              lat: v.displayLat,
              lon: v.displayLon,
              bearing: v.bearing === undefined ? undefined : v.displayBearing,
              speed: v.speed,
              stopId: v.stopId,
              currentStatus: v.currentStatus,
              stale: v.stale || feedQuiet,
            })),
            approachStopsRef.current,
          ),
        );
        setData('approach-lines', lines);
        setData('approach-rings', rings);
        approachesDrawn = true;
      } else if (approachesDrawn) {
        setData('approach-lines', EMPTY);
        setData('approach-rings', EMPTY);
        approachesDrawn = false;
      }

      // Riding: keep the vehicle in view, gliding with it, unless the rider
      // has just moved the map to look at something else.
      const follow = followRef.current;
      if (follow && now - lastFollow >= FOLLOW_RIDE_MS && now - lastTouched.current >= FOLLOW_PAUSE_MS) {
        const vehicle = vehicles.find((v) => v.id === follow);
        if (vehicle) {
          lastFollow = now;
          instance.easeTo({
            center: [vehicle.displayLon, vehicle.displayLat],
            zoom: Math.max(instance.getZoom(), 14),
            duration: FOLLOW_RIDE_MS,
            easing: (t) => t,
          });
        }
      }

      // The selected vehicle's trail, once a second: it grows by one point
      // per feed update, and only its head moves in between.
      const selected = selectedRef.current;
      if (selected && now - lastTrail >= TRAIL_REFRESH_MS) {
        lastTrail = now;
        const path = tracker.trail(selected);
        setData(
          'vehicle-trail',
          path.length >= 2
            ? { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: path }, properties: {} }] }
            : EMPTY,
        );
      }
    });
  }, [tracker, setData]);

  // --- Aircraft, updated per animation frame ---------------------------------
  useEffect(() => {
    let lastTrail = 0;
    let drawn = false;
    let aheadDrawn = false;
    return planeTracker.onFrame((planes: TrackedPlane[]) => {
      const instance = map.current;
      if (!ready.current || !instance) return;
      // A journey playing has the map to itself; planes would only be
      // invisible things to tap by mistake.
      if (playingRef.current) planes = [];
      if (planes.length === 0 && !drawn) return;
      drawn = planes.length > 0;
      const zoom = instance.getZoom();
      const selected = selectedPlaneRef.current;
      const features: GeoJSON.Feature[] = [];
      for (const plane of planes) {
        // A ramp full of parked airliners is a blob at metro scale; they
        // appear once the airport is close enough to be a place.
        if (plane.onGround && zoom < GROUND_PLANES_FROM_ZOOM && plane.id !== selected) continue;
        features.push(planeFeature(plane));
      }
      setData('planes', { type: 'FeatureCollection', features });

      // The way ahead, from wherever the chosen plane is drawn this frame.
      const chosen = selected ? planes.find((p) => p.id === selected) : undefined;
      const bound = planeBoundRef.current;
      if (chosen && bound) {
        setData('plane-ahead', { type: 'FeatureCollection', features: [aheadLine(chosen, bound)] });
        aheadDrawn = true;
      } else if (aheadDrawn) {
        setData('plane-ahead', EMPTY);
        aheadDrawn = false;
      }

      const now = performance.now();
      if (selected && now - lastTrail >= TRAIL_REFRESH_MS) {
        lastTrail = now;
        const path = planeTracker.trail(selected);
        setData(
          'plane-trail',
          path.length >= 2
            ? { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: path }, properties: {} }] }
            : EMPTY,
        );
      }
    });
  }, [planeTracker, setData]);

  // --- Selection highlight --------------------------------------------------
  useEffect(() => {
    const instance = map.current;
    if (!ready.current || !instance?.getLayer('vehicles-selected')) return;
    instance.setFilter('vehicles-selected', ['==', ['get', 'id'], selectedVehicleId ?? NO_SELECTION]);
    // A new selection re-forms groups at once, so the chosen vehicle steps out
    // of whatever group it was in on this frame rather than the next refresh.
    cameraMoved.current = true;

    // The trail fades from nothing at its tail to the route's colour at the
    // vehicle. A gradient cannot read the colour from the data, so it is set
    // here, once per selection.
    setData('vehicle-trail', EMPTY);
    const color = selectedVehicleId ? tracker.get(selectedVehicleId)?.color : undefined;
    if (color && instance.getLayer('vehicle-trail-line')) {
      instance.setPaintProperty('vehicle-trail-line', 'line-gradient', [
        'interpolate',
        ['linear'],
        ['line-progress'],
        0,
        rgba(color, 0),
        0.6,
        rgba(color, 0.45),
        1,
        rgba(color, 0.95),
      ]);
    }
  }, [selectedVehicleId, styleEpoch, setData, tracker]);

  // The selected stop's routes, on a plate above its pin.
  const pinId = pin?.id ?? null;
  useEffect(() => {
    const instance = map.current;
    if (!ready.current || !instance) return;
    for (const layer of ['major-stop-badges', 'stop-badges'] as const) {
      if (instance.getLayer(layer)) instance.setFilter(layer, stopBadgeFilter(layer, pinId));
    }
  }, [pinId, styleEpoch]);

  // --- The animated journey -------------------------------------------------
  // Driven straight from the playback clock rather than through React: the
  // traveller moves every animation frame, and re-rendering the component tree
  // sixty times a second to move one dot would cost far more than the
  // animation. This is the same imperative path the live vehicle layer uses.
  useEffect(() => {
    let lastFollow = 0;
    return playback.subscribe(({ journey, position, playing, time }) => {
      const instance = map.current;
      if (!instance || !ready.current || !instance.getLayer('journey-traveller')) return;

      if (!journey || !position) {
        setData('journey-traveller', EMPTY);
        setData('journey-trail', EMPTY);
        return;
      }

      setData('journey-traveller', {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [position.lon, position.lat] },
            properties: { color: position.step.color },
          },
        ],
      });

      setData('journey-trail', {
        type: 'FeatureCollection',
        features: trailAt(journey, time).map((segment) => ({
          type: 'Feature' as const,
          geometry: { type: 'LineString' as const, coordinates: segment.path },
          properties: { color: segment.color },
        })),
      });

      // Follow only while playing, so a paused map can be panned and inspected
      // without the camera dragging it back. Throttled because `easeTo` on
      // every frame fights its own previous animation and the map judders.
      if (!playing) return;
      const now = performance.now();
      if (now - lastFollow < FOLLOW_INTERVAL_MS) return;
      lastFollow = now;
      instance.easeTo({
        center: [position.lon, position.lat],
        duration: FOLLOW_INTERVAL_MS,
        // Linear, so consecutive follows join into one continuous glide rather
        // than a series of little eases.
        easing: (t) => t,
      });
    });
  }, [playback, setData, styleEpoch]);

  // --- Overlay colours for the map's ground ---------------------------------
  // The three effects below run in this order on purpose: theme colours, then
  // dimming for the selection, then playback's deeper dimming on top. Effects
  // run in declaration order, and each later one reads what the earlier left.
  const mapIsDark = isDarkMap(basemap, dark);
  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready.current) return;
    syncOverlayTheme(instance, PALETTES[mapIsDark ? 'dark' : 'light']);
    syncBuildingColor(instance, PALETTES[mapIsDark ? 'dark' : 'light']);
  }, [mapIsDark, styleEpoch]);

  // --- Everything not about the selection steps back ------------------------
  const focusKey = focus ? `${focus.kind}:${focus.routeIds.join('|')}` : '';
  const focusRefValue = useRef(focus);
  focusRefValue.current = focus;
  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready.current) return;
    syncSelectionFocus(instance, focusRefValue.current);
  }, [focusKey, styleEpoch]);

  // --- Where the chosen plane is going: its end of the line -----------------
  const boundKey = planeBound ? `${planeBound.label}|${planeBound.lat}|${planeBound.lon}` : '';
  useEffect(() => {
    if (!ready.current) return;
    const bound = planeBoundRef.current;
    setData(
      'plane-ahead-end',
      bound
        ? {
            type: 'FeatureCollection',
            features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [bound.lon, bound.lat] }, properties: { label: bound.label } }],
          }
        : EMPTY,
    );
    if (!bound) setData('plane-ahead', EMPTY);
  }, [boundKey, styleEpoch, setData]);

  // --- The chosen plane, and planes stepping back for transit ---------------
  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready.current) return;
    syncPlaneFocus(instance, { transitFocused, selectedId: selectedPlaneId, hoveredId: hoveredPlane.current });
    setData('plane-trail', EMPTY);
  }, [transitFocused, selectedPlaneId, styleEpoch, setData]);

  // --- Focus on the journey -------------------------------------------------
  // The cleanup is the restore, so a style swap mid-playback (which bumps
  // `styleEpoch`) tears this down and sets it up again against the new layers
  // rather than trying to write remembered values onto layers that are gone.
  // The theme and selection are dependencies for the same reason: either
  // changing rewrites the values this saved, so it restores and re-applies
  // over the new ones.
  useEffect(() => {
    const instance = map.current;
    if (!focusJourney || !instance || !ready.current || !instance.getLayer('network-line')) return;
    return applyJourneyFocus(instance, PALETTES[mapIsDark ? 'dark' : 'light']);
  }, [focusJourney, styleEpoch, mapIsDark, focusKey, selectedPlaneId]);

  // --- Basemap --------------------------------------------------------------
  // setStyle drops every custom source and layer; the `styledata` listener
  // above puts them all back, which is why nothing else is needed here.
  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready.current) return;
    // An explicit choice is always attempted, even if an earlier style failed
    // and left the plain background in place: imagery may be reachable where
    // vector tiles were not. Clearing the guard lets this style fall back on
    // its own merits rather than inheriting the previous one's verdict.
    // Satellite looks the same in either theme, so a theme change while on
    // satellite must not reload it.
    const style = styleFor(basemap, dark);
    if (style === appliedStyle.current && !usedFallback.current) return;
    appliedStyle.current = style;
    usedFallback.current = false;
    instance.setStyle(style);
  }, [basemap, dark]);

  // --- 2D / 3D --------------------------------------------------------------
  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready.current) return;

    // Rotation is a 3D affordance: in a flat north-up map a rotated compass is
    // just a way to get lost.
    if (three) {
      instance.dragRotate.enable();
      instance.touchZoomRotate.enableRotation();
    } else {
      instance.dragRotate.disable();
      instance.touchZoomRotate.disableRotation();
    }

    const pitch = three ? PITCH_3D : 0;
    // Coming back to 2D also squares the map up, so "2D" always means the
    // same thing rather than whatever heading you happened to leave behind.
    const bearing = three ? instance.getBearing() : 0;
    // Only when something would change: this also runs on every style load,
    // and an ease that goes nowhere still cancels whatever the camera was
    // doing — a flight to a shared stop, say.
    if (Math.abs(instance.getPitch() - pitch) > 0.5 || Math.abs(instance.getBearing() - bearing) > 0.5) {
      instance.easeTo({ pitch, bearing, duration: 600 });
    }
    syncBuildings(instance, three, paletteRef.current);
  }, [three, styleEpoch]);

  // --- The selected vehicle's trip -----------------------------------------
  // First drawn on whole, terminus to terminus, like a pen along a route
  // diagram; then replaced by the version cut at the vehicle, the road
  // already travelled faded and the road ahead bold.
  const vehicleTripRef = useRef(vehicleTrip);
  vehicleTripRef.current = vehicleTrip;
  const tripKey =
    vehicleTrip && vehicleTrip.geometry.length >= 2 ? `${vehicleTrip.vehicleId}|${vehicleTrip.tripId}` : null;
  const revealedTripRef = useRef<string | null>(null);
  const [revealedTrip, setRevealedTrip] = useState<string | null>(null);
  useEffect(() => {
    const instance = map.current;
    if (!ready.current || !instance) return;
    const trip = vehicleTripRef.current;
    if (!tripKey || !trip) {
      setData('vehicle-trip-full', EMPTY);
      revealedTripRef.current = null;
      setRevealedTrip(null);
      return;
    }
    if (revealedTripRef.current === tripKey) return;
    setData('vehicle-trip-full', {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: trip.geometry }, properties: {} }],
    });
    return revealLines(
      instance,
      [
        { id: 'vehicle-trip-reveal-casing', color: paletteRef.current.casing },
        { id: 'vehicle-trip-reveal', color: `#${trip.route.color}` },
      ],
      TRIP_REVEAL_MS,
      () => {
        revealedTripRef.current = tripKey;
        setRevealedTrip(tripKey);
      },
    );
  }, [tripKey, styleEpoch, setData]);

  useEffect(() => {
    if (!ready.current) return;
    if (!vehicleTrip || !tripKey || revealedTrip !== tripKey) {
      setData('vehicle-trip', EMPTY);
      setData('vehicle-trip-stops', EMPTY);
      return;
    }
    const color = `#${vehicleTrip.route.color}`;
    const { behind, ahead } = vehiclePosition
      ? splitLineAt(vehicleTrip.geometry, vehiclePosition)
      : { behind: [], ahead: vehicleTrip.geometry };
    const line = (coordinates: [number, number][], part: 'behind' | 'ahead') => ({
      type: 'Feature' as const,
      geometry: { type: 'LineString' as const, coordinates },
      properties: { color, part },
    });
    setData('vehicle-trip', {
      type: 'FeatureCollection',
      features: [
        ...(behind.length >= 2 ? [line(behind, 'behind')] : []),
        ...(ahead.length >= 2 ? [line(ahead, 'ahead')] : []),
      ],
    });
    setData('vehicle-trip-stops', {
      type: 'FeatureCollection',
      features: vehicleTrip.stops.slice(vehicleTrip.nextStopIndex).map((stop) => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [stop.stop.lon, stop.stop.lat] },
        properties: { color, id: stop.stop.id },
      })),
    });
    // The drawn-on line has done its job; the cut one sits where it was.
    setData('vehicle-trip-full', EMPTY);
  }, [vehicleTrip, tripKey, revealedTrip, vehiclePosition, setData, styleEpoch]);

  // --- The selected stop's pin ---------------------------------------------
  // A DOM marker rather than a map layer: it is anchored to the stop's
  // coordinates, so it rides along with every pan, zoom and tilt, it draws
  // above everything including the 3D buildings, and it survives basemap
  // swaps untouched because it is not part of the style.
  const pinMarker = useRef<maplibregl.Marker | null>(null);
  const pinLat = pin?.lat;
  const pinLon = pin?.lon;
  const pinName = pin?.name;
  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    if (pinLat === undefined || pinLon === undefined) {
      pinMarker.current?.remove();
      pinMarker.current = null;
      return;
    }
    if (!pinMarker.current) {
      pinMarker.current = new maplibregl.Marker({ element: createPinElement(), anchor: 'bottom' });
    }
    pinMarker.current.setLngLat([pinLon, pinLat]).addTo(instance);
    pinMarker.current.getElement().setAttribute('aria-label', `Selected stop: ${pinName ?? ''}`);
    pinMarker.current.getElement().title = pinName ?? '';
  }, [pinLat, pinLon, pinName]);
  useEffect(
    () => () => {
      pinMarker.current?.remove();
    },
    [],
  );

  // --- The part of the map not covered by panels ---------------------------
  const { top: padTop, right: padRight, bottom: padBottom, left: padLeft } = padding;
  const paddingRef = useRef(padding);
  paddingRef.current = padding;
  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    // Eased, so opening the panel slides the view over rather than jumping it.
    const apply = () =>
      instance.easeTo({ padding: { top: padTop, right: padRight, bottom: padBottom, left: padLeft }, duration: 260 });
    // A camera already in flight — to a stop from a shared link, say — must
    // not be cut short by the panel opening; the padding follows once it lands.
    if (instance.isMoving()) {
      instance.once('moveend', apply);
      return () => {
        instance.off('moveend', apply);
      };
    }
    apply();
  }, [padTop, padRight, padBottom, padLeft]);

  // --- Camera requests ------------------------------------------------------
  // Deliberately not keyed on `styleEpoch`: a basemap swap must not replay the
  // last flight.
  useEffect(() => {
    const instance = map.current;
    if (!instance || !cameraTarget) return;
    if ('bounds' in cameraTarget) {
      // The map's own padding already keeps clear of the panels; this is
      // only a margin inside what is left. Adding the panels again here asks
      // for a box that cannot fit, and MapLibre then quietly does nothing.
      instance.fitBounds(cameraTarget.bounds as LngLatBoundsLike, {
        padding: 40,
        bearing: 0,
        pitch: threeWanted.current ? PITCH_3D : 0,
        duration: 800,
      });
      return;
    }
    instance.flyTo({
      center: [cameraTarget.lon, cameraTarget.lat],
      zoom: Math.max(instance.getZoom(), cameraTarget.zoom),
      // Centred in whatever the panels leave uncovered, so it lands in view.
      padding: paddingRef.current,
      // Not `essential`, so someone who has asked for reduced motion gets a cut
      // rather than a swoop.
      duration: 900,
    });
  }, [cameraTarget]);

  // --- Beams on or off ------------------------------------------------------
  // `styleEpoch` is in the deps because a style swap rebuilds the layer, and
  // the rebuilt one needs the preference applied to it rather than to the
  // layer object that has just been discarded.
  useEffect(() => {
    const instance = map.current;
    if (!ready.current || !instance?.getLayer('vehicles-beam')) return;
    instance.setLayoutProperty('vehicles-beam', 'visibility', showBeams ? 'visible' : 'none');
  }, [showBeams, styleEpoch]);

  // --- Grouping on or off ---------------------------------------------------
  useEffect(() => {
    cameraMoved.current = true;
  }, [groupVehicles, focusKey]);

  // --- Who the aircraft come from -------------------------------------------
  // The credit is part of the control, so a changed one means a new control.
  useEffect(() => {
    const instance = map.current;
    if (!instance || !attributionControl.current) return;
    instance.removeControl(attributionControl.current);
    attributionControl.current = new maplibregl.AttributionControl({
      compact: true,
      customAttribution: planeAttribution ? [escapeHtml(agency.name), planeAttribution] : escapeHtml(agency.name),
    });
    instance.addControl(attributionControl.current, 'bottom-left');
  }, [planeAttribution, agency.name]);

  // --- Stops ----------------------------------------------------------------
  useEffect(() => {
    if (!ready.current) return;
    setData('stops', stopFeatures(stops));
  }, [stops, setData, styleEpoch]);

  // Every stop drawn, by id, for linking arriving vehicles to their stops.
  useEffect(() => {
    const index = new Map<string, ApproachStop>();
    for (const stop of [...majorStops, ...stops]) {
      index.set(stop.id, {
        id: stop.id,
        lat: stop.lat,
        lon: stop.lon,
        routeIds: new Set((stop.routes ?? []).map((route) => route.id)),
      });
    }
    approachStopsRef.current = index;
  }, [stops, majorStops]);

  useEffect(() => {
    if (!ready.current) return;
    setData('major-stops', stopFeatures(majorStops));
  }, [majorStops, setData, styleEpoch]);

  // --- How far you can get ---------------------------------------------------
  useEffect(() => {
    if (!ready.current) return;
    setData('isochrone', isochrone ?? EMPTY);
  }, [isochrone, setData, styleEpoch]);

  // --- The whole route network ----------------------------------------------
  useEffect(() => {
    if (!ready.current || !network) return;
    setData('network', network as unknown as GeoJSON.FeatureCollection);
  }, [network, setData, styleEpoch]);

  // --- Route shape ----------------------------------------------------------
  // Drawn on from one end when a route is chosen. A theme or basemap change
  // redraws it at once, without replaying the animation or the camera move.
  const shownShape = useRef<Props['routeShape']>(null);
  useEffect(() => {
    const instance = map.current;
    if (!ready.current || !instance) return;
    const fresh = shownShape.current !== routeShape;
    shownShape.current = routeShape;
    if (!routeShape) {
      setData('route-shape', EMPTY);
      return;
    }
    setData('route-shape', {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: routeShape.geometry }, properties: {} }],
    });
    if (fresh) fitTo(instance, routeShape.geometry);
    return revealLines(
      instance,
      [
        { id: 'route-shape-casing', color: paletteRef.current.casing },
        { id: 'route-shape-line', color: `#${routeShape.color}` },
      ],
      fresh ? ROUTE_REVEAL_MS : 0,
    );
  }, [routeShape, setData, styleEpoch]);

  // --- Planned itinerary ----------------------------------------------------
  useEffect(() => {
    if (!ready.current) return;
    if (!itinerary) {
      setData('itinerary', EMPTY);
      setData('itinerary-points', EMPTY);
      return;
    }

    const lines: GeoJSON.Feature[] = [];
    const points: GeoJSON.Feature[] = [];
    const all: [number, number][] = [];

    for (const leg of itinerary.legs) {
      if (leg.geometry.length >= 2) {
        lines.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: leg.geometry },
          properties: {
            color: leg.type === 'transit' ? `#${leg.route.color}` : paletteRef.current.muted,
            walk: leg.type === 'walk',
          },
        });
        all.push(...leg.geometry);
      }
      if (leg.type === 'transit') {
        points.push(
          markerFeature(leg.from.lon, leg.from.lat, leg.from.name, 'board', `#${leg.route.color}`),
          markerFeature(leg.to.lon, leg.to.lat, leg.to.name, 'alight', `#${leg.route.color}`),
        );
      }
    }

    setData('itinerary', { type: 'FeatureCollection', features: lines });
    setData('itinerary-points', { type: 'FeatureCollection', features: points });
    fitTo(map.current, all);
  }, [itinerary, setData, styleEpoch]);

  // --- Origin and destination pins -----------------------------------------
  useEffect(() => {
    if (!ready.current) return;
    const p = paletteRef.current;
    const features: GeoJSON.Feature[] = [];
    if (origin) features.push(markerFeature(origin.lon, origin.lat, 'Start', 'origin', p.text));
    if (destination) {
      features.push(markerFeature(destination.lon, destination.lat, 'Destination', 'destination', p.danger));
    }
    setData('endpoints', { type: 'FeatureCollection', features });
  }, [origin, destination, setData, styleEpoch, mapIsDark]);

  return <div ref={container} className="map" role="application" aria-label="Live transit map" />;
}

/**
 * The way ahead of a plane: the great circle to its destination or landing,
 * or, when only its heading is known, its track carried on as far as the
 * city it points at (and no further than an hour's flying).
 */
function aheadLine(plane: TrackedPlane, bound: NonNullable<Props['planeBound']>): GeoJSON.Feature {
  const from = { lat: plane.displayLat, lon: plane.displayLon };
  let coordinates: [number, number][];
  if (bound.kind === 'toward') {
    const km = Math.min(distanceKm(from, bound), ((plane.groundSpeed ?? 0) * 1.852) || 1);
    const end = deadReckon(from.lat, from.lon, plane.displayTrack, 3600, km / 1.852);
    coordinates = greatCircle(from, end, 24);
  } else {
    coordinates = greatCircle(from, bound, 64);
  }
  return { type: 'Feature', geometry: { type: 'LineString', coordinates }, properties: {} };
}

/** One aircraft as the map draws it. */
function planeFeature(plane: TrackedPlane): GeoJSON.Feature {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [plane.displayLon, plane.displayLat] },
    properties: {
      id: plane.id,
      track: plane.displayTrack,
      shape: planeShape(plane),
      alt: plane.altitude ?? 0,
      stale: plane.stale,
      label: planeLabel(plane),
      height: planeHeight(plane),
    },
  };
}

function markerFeature(
  lon: number,
  lat: number,
  name: string,
  kind: string,
  color: string,
): GeoJSON.Feature {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: { name, kind, color },
  };
}

/** Zooms to fit a set of coordinates, ignoring degenerate input. */
function fitTo(map: maplibregl.Map | null, coordinates: [number, number][]): void {
  if (!map || coordinates.length < 2) return;
  const bounds = coordinates.reduce(
    (acc, coord) => acc.extend(coord),
    new maplibregl.LngLatBounds(coordinates[0], coordinates[0]),
  );
  map.fitBounds(bounds, {
    padding: { top: 80, bottom: 80, left: 60, right: 60 },
    maxZoom: 15,
    duration: 800,
  });
}

/** The scrim that pushes the basemap back behind a playing journey. */
const FOCUS_SCRIM = 'journey-focus-scrim';

/**
 * Dims everything except the journey being played, and returns a function
 * that puts it back.
 *
 * Previous values are read off the map rather than assumed, so the restore is
 * exact even though most of these are zoom expressions rather than numbers.
 *
 * (Not literally blurred: the map is one canvas, so a blur applied to it would
 * take the journey with it. Dimming the surroundings and darkening the
 * basemap buys the same separation with none of that problem.)
 */
function applyJourneyFocus(map: maplibregl.Map, p: Palette): () => void {
  const saved: { layer: string; property: string; value: unknown }[] = [];

  for (const { layer, property, value } of JOURNEY_DIMMING) {
    if (!map.getLayer(layer)) continue;
    saved.push({ layer, property, value: getPaint(map, layer, property) });
    setPaint(map, layer, property, value);
  }

  if (!map.getLayer(FOCUS_SCRIM)) {
    try {
      map.addLayer(
        { id: FOCUS_SCRIM, type: 'background', paint: { 'background-color': p.bg, 'background-opacity': 0.6 } },
        // Above the basemap and its buildings, below everything this app draws.
        map.getLayer('network-casing') ? 'network-casing' : undefined,
      );
    } catch (err) {
      console.warn('livetrains: could not dim the map for playback', err);
    }
  }

  return () => {
    for (const { layer, property, value } of saved) {
      // A style swap during playback drops the layers; there is nothing to
      // restore, and the rebuilt style already carries the original values.
      if (!map.getLayer(layer)) continue;
      setPaint(map, layer, property, value);
    }
    if (map.getLayer(FOCUS_SCRIM)) map.removeLayer(FOCUS_SCRIM);
  };
}

/**
 * Adds or removes the extruded-buildings layer.
 *
 * Buildings come from vector tiles, which imagery cannot replace: an aerial
 * photo shows you roofs, not how far they are off the ground. Both styles
 * therefore carry a vector source, and this layer reads `building` from it.
 *
 * If no vector source has a `building` layer, nothing draws and nothing
 * breaks; that is simply what 3D looks like where there are no footprints.
 */
function syncBuildings(map: maplibregl.Map, three: boolean, p: Palette): void {
  const existing = map.getLayer(BUILDINGS_LAYER);
  if (!three) {
    if (existing) map.removeLayer(BUILDINGS_LAYER);
    return;
  }
  if (existing) return;

  const source = vectorSourceId(map);
  if (!source) return;

  try {
    map.addLayer(
      {
        id: BUILDINGS_LAYER,
        type: 'fill-extrusion',
        source,
        'source-layer': 'building',
        // Below this the footprints are smaller than their own outlines.
        minzoom: 14,
        paint: {
          'fill-extrusion-color': p.rule,
          // OpenMapTiles pre-computes render_height; height is the raw tag.
          'fill-extrusion-height': ['coalesce', ['get', 'render_height'], ['get', 'height'], 8],
          'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], ['get', 'min_height'], 0],
          // Translucent so the route network underneath stays readable.
          'fill-extrusion-opacity': 0.7,
        },
      },
      // Under everything this app draws, so a bus is never inside a building.
      map.getLayer('network-casing') ? 'network-casing' : undefined,
    );
  } catch (err) {
    console.warn('livetrains: could not add 3D buildings', err);
  }
}

function syncBuildingColor(map: maplibregl.Map, p: Palette): void {
  if (map.getLayer(BUILDINGS_LAYER)) map.setPaintProperty(BUILDINGS_LAYER, 'fill-extrusion-color', p.rule);
}

/** The id of a vector source that might carry building footprints. */
function vectorSourceId(map: maplibregl.Map): string | null {
  const sources = map.getStyle()?.sources ?? {};
  if (sources[VECTOR_SOURCE_ID]?.type === 'vector') return VECTOR_SOURCE_ID;
  for (const [id, source] of Object.entries(sources)) {
    if (source.type === 'vector') return id;
  }
  return null;
}
