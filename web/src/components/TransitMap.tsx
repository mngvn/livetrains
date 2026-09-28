import { useCallback, useEffect, useRef, useState } from 'react';
import maplibregl, { type LngLatBoundsLike, type MapGeoJSONFeature } from 'maplibre-gl';
import type { AgencyInfo, Itinerary, StopSummary } from '../lib/api.ts';
import type { TrackedVehicle, VehicleTracker } from '../lib/vehicleTracker.ts';
import type { RouteNetwork } from '../lib/api.ts';
import { MODE_TO_ICON, registerVehicleIcons } from './mapIcons.ts';
import { BASEMAPS, FALLBACK_STYLE, VECTOR_SOURCE_ID, type BasemapId } from './basemaps.ts';
import type { JourneyPlayback } from '../lib/journeyPlayback.ts';
import { trailAt } from '../lib/journey.ts';

/**
 * The live map.
 *
 * MapLibre GL with open vector tiles, so there is no API key to obtain, no
 * billing account, and no usage ceiling. Vehicles, stops and the planned route
 * are drawn as GeoJSON sources updated imperatively — React renders the chrome
 * around the map, never the map contents, because the vehicle layer updates on
 * every animation frame.
 */

interface Props {
  agency: AgencyInfo;
  tracker: VehicleTracker;
  stops: StopSummary[];
  itinerary: Itinerary | null;
  /** Route shape to highlight when browsing a route. */
  routeShape: { geometry: [number, number][]; color: string } | null;
  /** Every route's shape, drawn as a faint underlay. */
  network: RouteNetwork | null;
  selectedVehicleId: string | null;
  origin: { lat: number; lon: number } | null;
  destination: { lat: number; lon: number } | null;
  onSelectVehicle: (id: string | null) => void;
  onSelectStop: (stopId: string) => void;
  onMapClick: (lat: number, lon: number) => void;
  onViewportChange: (bbox: [number, number, number, number]) => void;
  /** Whether vehicles throw their colour beams. */
  showBeams: boolean;
  /** Which background the map wears. */
  basemap: BasemapId;
  /** Tilt the camera and extrude buildings. */
  three: boolean;
  /** Drives the animated traveller, when a journey is being played. */
  playback: JourneyPlayback;
  /** Dim everything that is not the journey being played. */
  focusJourney: boolean;
}

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

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

export function TransitMap({
  agency,
  tracker,
  stops,
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
  basemap,
  three,
  playback,
  focusJourney,
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
   * The beam preference, readable from the map's own listeners.
   *
   * Layers are (re)created from `load` and `styledata`, which are attached once
   * and never see later props. Reading the current value here means a rebuilt
   * beam layer is born with the right visibility rather than flashing on and
   * being switched off a frame later.
   */
  const beamsWanted = useRef(showBeams);
  beamsWanted.current = showBeams;
  /** The view mode at construction, so the first frame is already right. */
  const initial = useRef({ basemap, three });
  /** Read from the map's own listeners, which never see later props. */
  const threeWanted = useRef(three);
  threeWanted.current = three;
  // Handlers change on every render; hold them in a ref so the map's own
  // listeners can stay attached for the life of the component.
  const handlers = useRef({ onSelectVehicle, onSelectStop, onMapClick, onViewportChange });
  handlers.current = { onSelectVehicle, onSelectStop, onMapClick, onViewportChange };

  const setData = useCallback((id: string, data: GeoJSON.FeatureCollection) => {
    const source = map.current?.getSource(id) as maplibregl.GeoJSONSource | undefined;
    source?.setData(data);
  }, []);

  // --- Map construction (once) ---------------------------------------------
  useEffect(() => {
    if (!container.current || map.current) return;

    const instance = new maplibregl.Map({
      container: container.current,
      style: BASEMAPS[initial.current.basemap].style,
      bounds: agency.bbox as LngLatBoundsLike,
      fitBoundsOptions: { padding: 40 },
      attributionControl: false,
      pitch: initial.current.three ? PITCH_3D : 0,
      // 2D is north-up and flat; rotation is enabled only in 3D, where being
      // able to turn the city round is the whole point of the tilt.
      pitchWithRotate: initial.current.three,
      dragRotate: initial.current.three,
    });
    map.current = instance;

    instance.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    instance.addControl(
      new maplibregl.AttributionControl({ compact: true, customAttribution: agency.name }),
      'bottom-left',
    );
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
      // that never loads holds it false forever. Rebuilding on that signal is
      // what left the map with no trains until the page was reloaded.
      // `getStyle()` starts answering as soon as the spec is in place, which
      // is exactly when layers can be added.
      if (!instance.getStyle()) return;
      try {
        registerVehicleIcons(instance);
        if (ensureLayers(instance, beamsWanted.current)) setStyleEpoch((epoch) => epoch + 1);
        syncBuildings(instance, threeWanted.current);
      } catch (err) {
        // The style was not as ready as it looked; `styledata` fires again.
        console.warn('livetrains: deferring layer rebuild', err);
        return;
      }
      ready.current = true;
      // `load` never fires when the first style fails, so this is also the only
      // chance to report the initial viewport — without it the nearby-stops and
      // stops-in-view queries would never run.
      emitViewport();
    };

    instance.on('load', rebuild);
    instance.on('styledata', rebuild);

    instance.on('error', (event) => {
      const failure = event as { error?: Error; sourceId?: string };
      // MapLibre tags source and tile failures with the source they came from.
      // Those are local and transient — one aerial tile that will not load, a
      // vector source that has no buildings here — and recovering from them by
      // throwing the whole style away would turn a missing tile into a missing
      // map. Only a style document that cannot be fetched leaves nothing to
      // draw, and that is the one worth falling back from.
      if (failure.sourceId !== undefined) return;
      const message = String(failure.error?.message ?? '');
      if (!usedFallback.current && /style|positron|Failed to fetch/i.test(message)) {
        usedFallback.current = true;
        console.warn('livetrains: basemap unavailable, falling back to a plain background');
        instance.setStyle(FALLBACK_STYLE);
      }
    });

    instance.on('moveend', emitViewport);

    // --- Interaction ---
    const pickFeature = (event: maplibregl.MapMouseEvent): MapGeoJSONFeature | null => {
      const layers = ['vehicles-hit', 'stops-circle', 'itinerary-stops'].filter((id) => instance.getLayer(id));
      if (layers.length === 0) return null;
      const hits = instance.queryRenderedFeatures(event.point, { layers });
      return hits[0] ?? null;
    };

    instance.on('click', (event) => {
      const feature = pickFeature(event);
      if (!feature) {
        handlers.current.onSelectVehicle(null);
        handlers.current.onMapClick(event.lngLat.lat, event.lngLat.lng);
        return;
      }
      if (feature.layer.id === 'vehicles-hit') {
        handlers.current.onSelectVehicle(String(feature.properties?.id ?? ''));
      } else {
        handlers.current.onSelectStop(String(feature.properties?.id ?? ''));
      }
    });

    instance.on('mousemove', (event) => {
      instance.getCanvas().style.cursor = pickFeature(event) ? 'pointer' : '';
    });

    return () => {
      instance.remove();
      map.current = null;
      ready.current = false;
    };
    // Rebuilding the map on agency change is correct — it is a different city.
  }, [agency.bbox, agency.name]);

  // --- Live vehicles, updated per animation frame ---------------------------
  useEffect(
    () =>
      tracker.onFrame((vehicles: TrackedVehicle[]) => {
        if (!ready.current || !map.current) return;
        setData('vehicles', {
          type: 'FeatureCollection',
          features: vehicles.map((v) => ({
            type: 'Feature' as const,
            geometry: { type: 'Point' as const, coordinates: [v.displayLon, v.displayLat] },
            properties: {
              id: v.id,
              color: `#${v.color}`,
              label: v.routeShortName ?? '',
              bearing: v.displayBearing,
              mode: v.mode,
              // Only draw a heading arrow when the feed actually reported one;
              // an arrow pointing north on a vehicle of unknown heading is a
              // confident lie.
              hasHeading: v.bearing !== undefined,
            },
          })),
        });
      }),
    [tracker, setData],
  );

  // --- Selection highlight --------------------------------------------------
  useEffect(() => {
    if (!ready.current || !map.current) return;
    map.current.setFilter('vehicles-selected', [
      '==',
      ['get', 'id'],
      selectedVehicleId ?? NO_SELECTION,
    ]);
  }, [selectedVehicleId, styleEpoch]);

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

  // --- Focus on the journey -------------------------------------------------
  // The cleanup is the restore, so a style swap mid-playback (which bumps
  // `styleEpoch`) tears this down and sets it up again against the new layers
  // rather than trying to write remembered values onto layers that are gone.
  useEffect(() => {
    const instance = map.current;
    if (!focusJourney || !instance || !ready.current || !instance.getLayer('network-line')) return;
    return applyFocus(instance, showBeams);
  }, [focusJourney, showBeams, styleEpoch]);

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
    usedFallback.current = false;
    instance.setStyle(BASEMAPS[basemap].style);
  }, [basemap]);

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

    instance.easeTo({
      pitch: three ? PITCH_3D : 0,
      // Coming back to 2D also squares the map up, so "2D" always means the
      // same thing rather than whatever heading you happened to leave behind.
      bearing: three ? instance.getBearing() : 0,
      duration: 600,
    });
    syncBuildings(instance, three);
  }, [three, styleEpoch]);

  // --- Beams on or off ------------------------------------------------------
  // `styleEpoch` is in the deps because a style swap rebuilds the layer, and
  // the rebuilt one needs the preference applied to it rather than to the
  // layer object that has just been discarded.
  useEffect(() => {
    const instance = map.current;
    if (!ready.current || !instance?.getLayer('vehicles-beam')) return;
    instance.setLayoutProperty('vehicles-beam', 'visibility', showBeams ? 'visible' : 'none');
  }, [showBeams, styleEpoch]);

  // --- Stops ----------------------------------------------------------------
  useEffect(() => {
    if (!ready.current) return;
    setData('stops', {
      type: 'FeatureCollection',
      features: stops.map((stop) => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [stop.lon, stop.lat] },
        properties: { id: stop.id, name: stop.name },
      })),
    });
  }, [stops, setData, styleEpoch]);

  // --- The whole route network, drawn faintly underneath --------------------
  useEffect(() => {
    if (!ready.current || !network) return;
    setData('network', network as unknown as GeoJSON.FeatureCollection);
  }, [network, setData, styleEpoch]);

  // --- Route shape ----------------------------------------------------------
  useEffect(() => {
    if (!ready.current) return;
    if (!routeShape) {
      setData('route-shape', EMPTY);
      return;
    }
    setData('route-shape', {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: routeShape.geometry },
          properties: { color: `#${routeShape.color}` },
        },
      ],
    });
    fitTo(map.current, routeShape.geometry);
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
            color: leg.type === 'transit' ? `#${leg.route.color}` : '#64748b',
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
    const features: GeoJSON.Feature[] = [];
    if (origin) features.push(markerFeature(origin.lon, origin.lat, 'Start', 'origin', '#1d4ed8'));
    if (destination) {
      features.push(markerFeature(destination.lon, destination.lat, 'Destination', 'destination', '#be123c'));
    }
    setData('endpoints', { type: 'FeatureCollection', features });
  }, [origin, destination, setData, styleEpoch]);

  return <div ref={container} className="map" role="application" aria-label="Live transit map" />;
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

/**
 * What playback fades, and how far.
 *
 * Journey playback is an argument about one trip, so everything that is not
 * that trip steps back: the rest of the network, every other vehicle, the
 * stops you are not using. They are dimmed rather than hidden, because a route
 * floating in a void reads as a diagram, and the point of playing it on a map
 * is that it is a real place.
 *
 * (Not literally blurred: the map is one canvas, so a blur applied to it would
 * take the journey with it. Dimming the surroundings and darkening the
 * basemap buys the same separation with none of that problem.)
 */
const FOCUS_DIMMING: { layer: string; property: string; value: number }[] = [
  { layer: 'network-line', property: 'line-opacity', value: 0.05 },
  { layer: 'route-shape-casing', property: 'line-opacity', value: 0 },
  { layer: 'route-shape-line', property: 'line-opacity', value: 0.08 },
  { layer: 'stops-circle', property: 'circle-opacity', value: 0.1 },
  { layer: 'stops-circle', property: 'circle-stroke-opacity', value: 0.1 },
  { layer: 'stops-label', property: 'text-opacity', value: 0 },
  { layer: 'vehicles-beam', property: 'icon-opacity', value: 0 },
  { layer: 'vehicles-selected', property: 'circle-opacity', value: 0 },
  { layer: 'vehicles-heading', property: 'icon-opacity', value: 0.1 },
  { layer: 'vehicles-dot', property: 'icon-opacity', value: 0.16 },
  { layer: 'vehicles-label', property: 'text-opacity', value: 0 },
];

/** The scrim that pushes the basemap back behind the journey. */
const FOCUS_SCRIM = 'journey-focus-scrim';

/**
 * Dims everything except the journey, and returns a function that puts it back.
 *
 * Previous values are read off the map rather than assumed, so the restore is
 * exact even though most of these are zoom expressions rather than numbers.
 */
function applyFocus(map: maplibregl.Map, showBeams: boolean): () => void {
  const saved: { layer: string; property: string; value: unknown }[] = [];

  for (const { layer, property, value } of FOCUS_DIMMING) {
    if (!map.getLayer(layer)) continue;
    saved.push({ layer, property, value: map.getPaintProperty(layer, property) });
    map.setPaintProperty(layer, property, value);
  }

  if (!map.getLayer(FOCUS_SCRIM)) {
    try {
      map.addLayer(
        {
          id: FOCUS_SCRIM,
          type: 'background',
          paint: { 'background-color': '#04101f', 'background-opacity': 0.55 },
        },
        // Above the basemap and its buildings, below everything this app draws.
        map.getLayer('network-line') ? 'network-line' : undefined,
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
      map.setPaintProperty(layer, property, value);
    }
    // The beams answer to their own switch, which focus mode must not override.
    if (map.getLayer('vehicles-beam')) {
      map.setLayoutProperty('vehicles-beam', 'visibility', showBeams ? 'visible' : 'none');
    }
    if (map.getLayer(FOCUS_SCRIM)) map.removeLayer(FOCUS_SCRIM);
  };
}

/**
 * Adds or removes the extruded-buildings layer.
 *
 * Buildings come from vector tiles, which imagery cannot replace: an aerial
 * photo shows you roofs, not how far they are off the ground. Both styles
 * therefore carry a vector source, and this layer reads `building` from
 * whichever one is present — the app's own in satellite mode, the hosted
 * style's in street mode, where the convention is to call it `openmaptiles`.
 *
 * If no vector source has a `building` layer, nothing draws and nothing
 * breaks; that is simply what 3D looks like where there are no footprints.
 */
function syncBuildings(map: maplibregl.Map, three: boolean): void {
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
          'fill-extrusion-color': '#c8cfd8',
          // OpenMapTiles pre-computes render_height; height is the raw tag.
          'fill-extrusion-height': ['coalesce', ['get', 'render_height'], ['get', 'height'], 8],
          'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], ['get', 'min_height'], 0],
          // Translucent so the route network underneath stays readable, and
          // faded in over a zoom level so buildings do not pop into being.
          'fill-extrusion-opacity': 0.65,
        },
      },
      // Under everything this app draws, so a bus is never inside a building.
      map.getLayer('network-line') ? 'network-line' : undefined,
    );
  } catch (err) {
    console.warn('livetrains: could not add 3D buildings', err);
  }
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

/**
 * Declares every source and layer once, in draw order.
 *
 * Order matters: the planned route sits above the basemap but below stops, and
 * vehicles sit on top of everything so a bus is never hidden behind a stop dot.
 */
function ensureLayers(map: maplibregl.Map, showBeams: boolean): boolean {
  // Idempotent: called on every style load, and a style swap wipes what was
  // added before. Returns true when it created the layers, which tells the
  // caller the sources are empty and need refilling.
  if (map.getLayer('vehicles-hit')) return false;
  for (const id of [
    'network', 'route-shape', 'itinerary', 'itinerary-points', 'stops', 'vehicles', 'endpoints',
    'journey-trail', 'journey-traveller',
  ]) {
    if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: EMPTY });
  }

  // --- The whole route network, underneath everything ---
  // Deliberately faint. It is there to show that vehicles follow lines rather
  // than drift across a blank field; if it competes with the vehicles for
  // attention it has failed at its one job. Opacity and width both grow with
  // zoom, so it stays a wash at metro scale and becomes a readable map of the
  // corridors once you are looking at a neighbourhood.
  map.addLayer({
    id: 'network-line',
    type: 'line',
    source: 'network',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['get', 'color'],
      'line-width': [
        'interpolate',
        ['linear'],
        ['zoom'],
        9,
        ['case', ['get', 'rail'], 1.6, 0.8],
        13,
        ['case', ['get', 'rail'], 3, 1.6],
        16,
        ['case', ['get', 'rail'], 5, 2.6],
      ],
      'line-opacity': [
        'interpolate',
        ['linear'],
        ['zoom'],
        8,
        0.12,
        11,
        ['case', ['get', 'rail'], 0.36, 0.2],
        15,
        ['case', ['get', 'rail'], 0.42, 0.26],
      ],
    },
  });

  // --- Route shape (browsing a route) ---
  map.addLayer({
    id: 'route-shape-casing',
    type: 'line',
    source: 'route-shape',
    paint: { 'line-color': '#ffffff', 'line-width': 8, 'line-opacity': 0.9 },
    layout: { 'line-cap': 'round', 'line-join': 'round' },
  });
  map.addLayer({
    id: 'route-shape-line',
    type: 'line',
    source: 'route-shape',
    paint: { 'line-color': ['get', 'color'], 'line-width': 4.5 },
    layout: { 'line-cap': 'round', 'line-join': 'round' },
  });

  // --- Planned itinerary ---
  map.addLayer({
    id: 'itinerary-casing',
    type: 'line',
    source: 'itinerary',
    paint: { 'line-color': '#ffffff', 'line-width': 9, 'line-opacity': 0.95 },
    layout: { 'line-cap': 'round', 'line-join': 'round' },
  });
  map.addLayer({
    id: 'itinerary-line',
    type: 'line',
    source: 'itinerary',
    paint: {
      'line-color': ['get', 'color'],
      'line-width': 5,
      // Walking legs are dashed, the convention on every transit map.
      'line-dasharray': ['case', ['get', 'walk'], ['literal', [1, 1.6]], ['literal', [1, 0]]],
    },
    layout: { 'line-cap': 'butt', 'line-join': 'round' },
  });

  // --- Stops ---
  map.addLayer({
    id: 'stops-circle',
    type: 'circle',
    source: 'stops',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 2.5, 14, 4, 16, 6],
      'circle-color': '#ffffff',
      'circle-stroke-color': '#334155',
      'circle-stroke-width': 1.5,
      // Fade stops out when zoomed far enough back that they become clutter.
      'circle-opacity': ['interpolate', ['linear'], ['zoom'], 10.5, 0, 11.5, 1],
      'circle-stroke-opacity': ['interpolate', ['linear'], ['zoom'], 10.5, 0, 11.5, 1],
    },
  });
  map.addLayer({
    id: 'stops-label',
    type: 'symbol',
    source: 'stops',
    minzoom: 14.5,
    layout: {
      'text-field': ['get', 'name'],
      'text-size': 11,
      'text-offset': [0, 1.1],
      'text-anchor': 'top',
      'text-max-width': 9,
      'text-optional': true,
    },
    paint: { 'text-color': '#334155', 'text-halo-color': '#ffffff', 'text-halo-width': 1.4 },
  });

  // --- Itinerary boarding / alighting markers ---
  map.addLayer({
    id: 'itinerary-stops',
    type: 'circle',
    source: 'itinerary-points',
    paint: {
      'circle-radius': 6,
      'circle-color': '#ffffff',
      'circle-stroke-color': ['get', 'color'],
      'circle-stroke-width': 3.5,
    },
  });

  // --- Origin / destination pins ---
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
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 2.5,
    },
  });

  // --- Vehicles (topmost) ---
  // Beams first, so every marker and arrow draws over them.
  //
  // These exist for the zoomed-out view, where a vehicle is a four-pixel dot
  // that is genuinely hard to find. They fade out entirely as you zoom in:
  // once a vehicle is big enough to read, the shaft is just clutter over the
  // thing you came to look at.
  map.addLayer({
    id: 'vehicles-beam',
    type: 'symbol',
    source: 'vehicles',
    layout: {
      'icon-image': 'vehicle-beam',
      visibility: showBeams ? 'visible' : 'none',
      // Anchored at its foot, so the shaft rises from the vehicle.
      'icon-anchor': 'bottom',
      // Shrinks as you zoom in, not grows. The beam is a finding aid for the
      // wide view; letting it scale up with the map would make it loudest
      // exactly when the vehicle it points at no longer needs pointing at.
      'icon-size': ['interpolate', ['linear'], ['zoom'], 8, 0.95, 11, 0.7, 13, 0.42, 14, 0.3],
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
    paint: {
      'icon-color': ['get', 'color'],
      // Gone well before the zoom at which you would inspect a single vehicle,
      // so the marker is never competing with its own beam.
      'icon-opacity': [
        'interpolate',
        ['linear'],
        ['zoom'],
        8,
        0.5,
        10.5,
        0.38,
        12,
        0.18,
        13.5,
        0,
      ],
    },
  });

  // Selection halo, beneath the marker it belongs to.
  map.addLayer({
    id: 'vehicles-selected',
    type: 'circle',
    source: 'vehicles',
    // Filtered to the selected id; the sentinel matches nothing by default.
    filter: ['==', ['get', 'id'], NO_SELECTION],
    paint: { 'circle-radius': 18, 'circle-color': ['get', 'color'], 'circle-opacity': 0.25 },
  });

  // Heading arrow. The artwork sits above its own centre, so rotating the icon
  // swings the arrow around the vehicle; `icon-rotation-alignment: map` keeps
  // it pointing at real-world north rather than screen-up.
  map.addLayer({
    id: 'vehicles-heading',
    type: 'symbol',
    source: 'vehicles',
    filter: ['get', 'hasHeading'],
    layout: {
      'icon-image': 'vehicle-heading',
      'icon-rotate': ['get', 'bearing'],
      'icon-rotation-alignment': 'map',
      'icon-size': ['interpolate', ['linear'], ['zoom'], 9, 0.55, 13, 0.9, 16, 1.15],
      // Vehicles are the point of the map: never drop one for want of space.
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
    paint: {
      'icon-color': ['get', 'color'],
      'icon-halo-color': '#ffffff',
      // A wide halo is what separates the arrow from the route line it is
      // flying along, which is the same colour underneath it.
      'icon-halo-width': 1.6,
    },
  });

  // The marker itself. Shape carries the mode, colour carries the route, and
  // the halo keeps both legible on any basemap.
  map.addLayer({
    id: 'vehicles-dot',
    type: 'symbol',
    source: 'vehicles',
    layout: {
      'icon-image': MODE_TO_ICON,
      'icon-size': ['interpolate', ['linear'], ['zoom'], 9, 0.45, 13, 0.75, 16, 1],
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
    paint: {
      'icon-color': ['get', 'color'],
      'icon-halo-color': '#ffffff',
      'icon-halo-width': 1.4,
    },
  });

  // Route number, once the marker is big enough to hold it.
  map.addLayer({
    id: 'vehicles-label',
    type: 'symbol',
    source: 'vehicles',
    minzoom: 13,
    layout: {
      'text-field': ['get', 'label'],
      'text-size': 10,
      'text-allow-overlap': true,
      'text-ignore-placement': true,
    },
    paint: {
      'text-color': '#ffffff',
      'text-halo-color': ['get', 'color'],
      'text-halo-width': 1.2,
    },
  });

  // A generous invisible hit target: the markers are small on a phone.
  map.addLayer({
    id: 'vehicles-hit',
    type: 'circle',
    source: 'vehicles',
    paint: { 'circle-radius': 16, 'circle-opacity': 0 },
  });

  // --- The animated journey, above everything -------------------------------
  // Playback is a deliberate focus on one trip, so while it runs the traveller
  // and their trail outrank even the live fleet.
  map.addLayer({
    id: 'journey-trail',
    type: 'line',
    source: 'journey-trail',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['get', 'color'],
      'line-width': ['interpolate', ['linear'], ['zoom'], 11, 4, 15, 7],
      'line-opacity': 0.9,
    },
  });

  // A halo that reads as movement rather than as another vehicle.
  map.addLayer({
    id: 'journey-halo',
    type: 'circle',
    source: 'journey-traveller',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 12, 16, 22],
      'circle-color': ['get', 'color'],
      'circle-opacity': 0.22,
    },
  });

  map.addLayer({
    id: 'journey-traveller',
    type: 'circle',
    source: 'journey-traveller',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 6, 16, 10],
      'circle-color': ['get', 'color'],
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 2.5,
    },
  });

  return true;
}
