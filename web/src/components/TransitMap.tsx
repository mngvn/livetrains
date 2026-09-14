import { useCallback, useEffect, useRef, useState } from 'react';
import maplibregl, { type LngLatBoundsLike, type MapGeoJSONFeature } from 'maplibre-gl';
import type { AgencyInfo, Itinerary, StopSummary } from '../lib/api.ts';
import type { TrackedVehicle, VehicleTracker } from '../lib/vehicleTracker.ts';
import type { RouteNetwork } from '../lib/api.ts';
import { MODE_TO_ICON, registerVehicleIcons } from './mapIcons.ts';

/**
 * The live map.
 *
 * MapLibre GL with open vector tiles, so there is no API key to obtain, no
 * billing account, and no usage ceiling. Vehicles, stops and the planned route
 * are drawn as GeoJSON sources updated imperatively — React renders the chrome
 * around the map, never the map contents, because the vehicle layer updates on
 * every animation frame.
 */

/** Basemap style: free, no key required. */
const STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';

/**
 * A style that needs no network at all.
 *
 * MapLibre only fires `load` once a style resolves, and every custom source and
 * layer hangs off that event — so a failed basemap fetch would otherwise leave
 * the map permanently empty, with no vehicles, stops or routes. Falling back to
 * a plain background keeps the transit data visible and the app usable on a
 * flaky connection or behind a restrictive network; only the street imagery is
 * lost.
 */
const FALLBACK_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#e9edf2' } }],
};

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
}

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

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
      style: STYLE_URL,
      bounds: agency.bbox as LngLatBoundsLike,
      fitBoundsOptions: { padding: 40 },
      attributionControl: false,
      // Keep the interaction budget on the vehicles rather than on tilt.
      pitchWithRotate: false,
      dragRotate: false,
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

    instance.on('load', () => {
      registerVehicleIcons(instance);
      if (ensureLayers(instance)) setStyleEpoch((epoch) => epoch + 1);
      ready.current = true;
      emitViewport();
    });

    // setStyle drops every custom source and layer, so re-add them whenever a
    // style finishes loading, not only on the first one.
    instance.on('styledata', () => {
      if (!instance.isStyleLoaded()) return;
      // A style swap drops registered images along with the layers.
      registerVehicleIcons(instance);
      if (ensureLayers(instance)) setStyleEpoch((epoch) => epoch + 1);
      ready.current = true;
      // `load` never fires when the first style fails, so this is also the only
      // chance to report the initial viewport — without it the nearby-stops and
      // stops-in-view queries would never run.
      emitViewport();
    });

    instance.on('error', (event) => {
      const message = String((event as { error?: Error }).error?.message ?? '');
      // A style that cannot be fetched is the one error worth recovering from;
      // everything else (a single missing tile, say) is transient noise.
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
 * Declares every source and layer once, in draw order.
 *
 * Order matters: the planned route sits above the basemap but below stops, and
 * vehicles sit on top of everything so a bus is never hidden behind a stop dot.
 */
function ensureLayers(map: maplibregl.Map): boolean {
  // Idempotent: called on every style load, and a style swap wipes what was
  // added before. Returns true when it created the layers, which tells the
  // caller the sources are empty and need refilling.
  if (map.getLayer('vehicles-hit')) return false;
  for (const id of ['network', 'route-shape', 'itinerary', 'itinerary-points', 'stops', 'vehicles', 'endpoints']) {
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

  return true;
}
