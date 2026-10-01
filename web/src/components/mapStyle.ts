import type maplibregl from 'maplibre-gl';
import type { Palette } from '../lib/palette.ts';

/**
 * The street basemap, drawn by this app rather than borrowed.
 *
 * A hosted style is somebody else's idea of a map: shops, footpaths,
 * hillshade, a dozen greens and browns, all of it competing with the transit
 * network for the eye. This one is built for the network to sit on. Land,
 * water and roads are a few quiet values of one blue-grey; the only colour
 * on the finished map is the agency's own line colours, drawn on top.
 *
 * It reads OpenFreeMap's OpenMapTiles vector tiles — the same tiles and
 * glyphs the hosted styles use, so there is still nothing to sign up for.
 * Place names are set in spaced capitals, the way a station sign or a
 * printed network map names a neighbourhood.
 */

const OPENFREEMAP_TILES = 'https://tiles.openfreemap.org/planet';
const GLYPHS = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';

/** Every name, preferring the English one where the tiles carry it. */
const NAME: maplibregl.ExpressionSpecification = [
  'coalesce',
  ['get', 'name:en'],
  ['get', 'name_en'],
  ['get', 'name'],
];

export function transitBasemap(p: Palette, vectorSourceId: string): maplibregl.StyleSpecification {
  const roadWidth = (stops: [number, number][]): maplibregl.ExpressionSpecification => [
    'interpolate',
    ['exponential', 1.5],
    ['zoom'],
    ...stops.flat(),
  ];

  return {
    version: 8,
    glyphs: GLYPHS,
    sources: {
      [vectorSourceId]: { type: 'vector', url: OPENFREEMAP_TILES },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': p.land } },

      // Woods and parks as one faint step up from the ground: enough to see
      // the shape of the city, not enough to compete with a line.
      {
        id: 'landcover',
        type: 'fill',
        source: vectorSourceId,
        'source-layer': 'landcover',
        filter: ['in', ['get', 'class'], ['literal', ['wood', 'grass', 'farmland', 'wetland']]],
        paint: { 'fill-color': p.landcover },
      },
      {
        id: 'park',
        type: 'fill',
        source: vectorSourceId,
        'source-layer': 'park',
        paint: { 'fill-color': p.landcover },
      },
      {
        id: 'water',
        type: 'fill',
        source: vectorSourceId,
        'source-layer': 'water',
        filter: ['!=', ['get', 'brunnel'], 'tunnel'],
        paint: { 'fill-color': p.water },
      },
      {
        id: 'waterway',
        type: 'line',
        source: vectorSourceId,
        'source-layer': 'waterway',
        minzoom: 11,
        filter: ['in', ['get', 'class'], ['literal', ['river', 'canal']]],
        paint: { 'line-color': p.water, 'line-width': roadWidth([[11, 1], [16, 4]]) },
      },
      {
        id: 'building',
        type: 'fill',
        source: vectorSourceId,
        'source-layer': 'building',
        minzoom: 14,
        paint: {
          'fill-color': p.building,
          'fill-opacity': ['interpolate', ['linear'], ['zoom'], 14, 0, 15, 1],
        },
      },

      // Roads in three weights of the same grey. The transit lines drawn on
      // top are the map; the streets are the grid it is printed on.
      {
        id: 'road-minor',
        type: 'line',
        source: vectorSourceId,
        'source-layer': 'transportation',
        minzoom: 12.5,
        filter: ['in', ['get', 'class'], ['literal', ['minor', 'service']]],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': p.roadMinor, 'line-width': roadWidth([[12.5, 0.4], [15, 2], [18, 10]]) },
      },
      {
        id: 'road-mid',
        type: 'line',
        source: vectorSourceId,
        'source-layer': 'transportation',
        minzoom: 10,
        filter: ['in', ['get', 'class'], ['literal', ['secondary', 'tertiary']]],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': p.roadMid, 'line-width': roadWidth([[10, 0.4], [14, 2.2], [18, 14]]) },
      },
      {
        id: 'road-major',
        type: 'line',
        source: vectorSourceId,
        'source-layer': 'transportation',
        minzoom: 6,
        filter: ['in', ['get', 'class'], ['literal', ['motorway', 'trunk', 'primary']]],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': p.roadMajor, 'line-width': roadWidth([[6, 0.5], [10, 1.2], [14, 4], [18, 18]]) },
      },
      {
        id: 'railway',
        type: 'line',
        source: vectorSourceId,
        'source-layer': 'transportation',
        minzoom: 11,
        filter: ['==', ['get', 'class'], 'rail'],
        paint: {
          'line-color': p.rail,
          'line-width': roadWidth([[11, 0.6], [16, 2]]),
          'line-dasharray': [3, 2],
        },
      },

      // --- Labels ------------------------------------------------------------
      {
        id: 'label-water',
        type: 'symbol',
        source: vectorSourceId,
        'source-layer': 'water_name',
        layout: {
          'text-field': NAME,
          'text-font': ['Noto Sans Italic'],
          'text-size': 11,
          'text-letter-spacing': 0.12,
          'text-max-width': 8,
        },
        paint: { 'text-color': p.waterLabel, 'text-halo-color': p.halo, 'text-halo-width': 1.2 },
      },
      {
        id: 'label-street',
        type: 'symbol',
        source: vectorSourceId,
        'source-layer': 'transportation_name',
        minzoom: 14.5,
        layout: {
          'text-field': NAME,
          'text-font': ['Noto Sans Regular'],
          'text-size': 10.5,
          'symbol-placement': 'line',
          'text-rotation-alignment': 'map',
          'text-letter-spacing': 0.04,
        },
        paint: { 'text-color': p.streetLabel, 'text-halo-color': p.halo, 'text-halo-width': 1.4 },
      },
      {
        id: 'label-neighbourhood',
        type: 'symbol',
        source: vectorSourceId,
        'source-layer': 'place',
        minzoom: 11.5,
        filter: ['in', ['get', 'class'], ['literal', ['suburb', 'neighbourhood', 'quarter']]],
        layout: {
          'text-field': NAME,
          'text-font': ['Noto Sans Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 12, 9.5, 16, 12],
          'text-transform': 'uppercase',
          'text-letter-spacing': 0.18,
          'text-max-width': 7,
        },
        paint: { 'text-color': p.neighbourhoodLabel, 'text-halo-color': p.halo, 'text-halo-width': 1.2 },
      },
      {
        id: 'label-town',
        type: 'symbol',
        source: vectorSourceId,
        'source-layer': 'place',
        minzoom: 8,
        maxzoom: 14,
        filter: ['in', ['get', 'class'], ['literal', ['town', 'village']]],
        layout: {
          'text-field': NAME,
          'text-font': ['Noto Sans Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 8, 10, 13, 12.5],
          'text-transform': 'uppercase',
          'text-letter-spacing': 0.12,
          'text-max-width': 8,
        },
        paint: { 'text-color': p.placeLabel, 'text-halo-color': p.halo, 'text-halo-width': 1.3 },
      },
      {
        id: 'label-city',
        type: 'symbol',
        source: vectorSourceId,
        'source-layer': 'place',
        maxzoom: 13,
        filter: ['==', ['get', 'class'], 'city'],
        layout: {
          'text-field': NAME,
          'text-font': ['Noto Sans Bold'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 6, 12, 12, 17],
          'text-transform': 'uppercase',
          'text-letter-spacing': 0.2,
          'text-max-width': 8,
        },
        paint: { 'text-color': p.placeLabel, 'text-halo-color': p.halo, 'text-halo-width': 1.6 },
      },
    ],
  };
}
