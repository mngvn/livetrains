import type maplibregl from 'maplibre-gl';

/**
 * The backgrounds the map can wear.
 *
 * Two real ones and a fallback. All three are keyless: the point of this app
 * is that you can clone it and deploy it without signing up for anything, and
 * a basemap that needs a token would quietly undo that.
 */

export type BasemapId = 'streets' | 'satellite';

/**
 * Vector tiles for the street map, and for extruded buildings over imagery.
 *
 * OpenFreeMap serves the whole planet from this endpoint with no key and no
 * usage ceiling. It is referenced directly (rather than only through the
 * positron style) so that satellite mode can borrow it for building shapes,
 * which aerial imagery cannot supply — you can see roofs from above, not how
 * tall they are.
 */
const OPENFREEMAP_TILES = 'https://tiles.openfreemap.org/planet';

/**
 * The source id this app uses for the vector tiles it adds itself.
 *
 * Exported so the 3D building layer can find its source by name rather than
 * guessing at whatever a hosted style happened to call its own.
 */
export const VECTOR_SOURCE_ID = 'livetrains-vector';

/** Street basemap: a pale style that lets route colours carry the map. */
export const STREETS_STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';

/**
 * Esri's World Imagery, the standard keyless aerial basemap.
 *
 * Esri publishes it for use with attribution, which the map carries in its
 * attribution control.
 */
const ESRI_IMAGERY =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

export const ESRI_ATTRIBUTION =
  'Imagery &copy; Esri, Maxar, Earthstar Geographics, and the GIS User Community';

/**
 * Deepest zoom with real imagery behind it, over the Twin Cities.
 *
 * Past a raster source's `maxzoom`, MapLibre stops asking for tiles and
 * stretches the last ones it has — which is exactly what is wanted here,
 * because asking deeper is worse than stretching. Esri's service advertises
 * levels to 23, but over Minneapolis and St Paul every tile past 19 is the
 * same 2.5KB "map data not yet available" placeholder (checked from CI:
 * identical bytes downtown, in Uptown and in St Paul). This was briefly 20,
 * on the assumption that US metros carry level 20; here they do not, and the
 * result was a grey placeholder wherever you zoomed in closest.
 */
const IMAGERY_MAX_ZOOM = 19;

/**
 * The font stack labels are drawn in.
 *
 * OpenFreeMap serves Noto Sans from the glyph endpoint above. A stack that a
 * server cannot supply means no labels rather than a broken map, so the
 * imagery and the transit data are never at risk from this line.
 */
const LABEL_FONT = ['Noto Sans Regular'];

/**
 * The tile size to *declare* for the imagery, which is not its actual size.
 *
 * Esri's tiles are 256px images. Declaring that size asks MapLibre to fit one
 * tile to one map tile, so on a 2x display each image pixel is drawn across
 * four screen pixels and the photo looks soft — the single biggest reason
 * aerial imagery reads as low resolution on a modern laptop.
 *
 * Declaring half the true size instead tells MapLibre each tile covers half a
 * tile's worth of ground, so it fetches one zoom level deeper and draws the
 * same 256px image into a 128px slot: real detail at the display's own
 * resolution. It costs four times the requests, which is why it is only done
 * where the screen can actually show the difference.
 */
const IMAGERY_TILE_SIZE = typeof window !== 'undefined' && window.devicePixelRatio > 1.5 ? 128 : 256;

/**
 * A style that needs no network at all.
 *
 * MapLibre only fires `load` once a style resolves, and every custom source
 * and layer hangs off that event — so a failed basemap fetch would otherwise
 * leave the map permanently empty, with no vehicles, stops or routes. Falling
 * back to a plain background keeps the transit data visible and the app usable
 * on a flaky connection or behind a restrictive network; only the street
 * imagery is lost.
 */
export const FALLBACK_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#e9edf2' } }],
};

/**
 * The satellite style, assembled here rather than fetched.
 *
 * Labels are drawn from vector tiles rather than from Esri's raster reference
 * overlay. That overlay is a picture of text: it softens the moment you zoom
 * between its levels, and on a high-density screen it is visibly a photograph
 * of lettering sitting on a photograph of a city. Vector labels are redrawn
 * crisply at whatever the display can show, carry a halo that keeps them
 * readable over both a parking lot and a lake, and cost one request per tile
 * instead of a second full raster pyramid.
 */
export const SATELLITE_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
  sources: {
    'esri-imagery': {
      type: 'raster',
      tiles: [ESRI_IMAGERY],
      tileSize: IMAGERY_TILE_SIZE,
      maxzoom: IMAGERY_MAX_ZOOM,
      attribution: ESRI_ATTRIBUTION,
    },
    // Labels, and the building footprints 3D mode extrudes. If it fails to
    // load, imagery and transit data are unaffected.
    [VECTOR_SOURCE_ID]: { type: 'vector', url: OPENFREEMAP_TILES },
  },
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': '#0b1220' } },
    {
      id: 'esri-imagery',
      type: 'raster',
      source: 'esri-imagery',
      paint: {
        // Aerial imagery is hazy by nature — it is photographed through a few
        // kilometres of atmosphere. A little contrast and saturation puts the
        // snap back, and smooth resampling keeps the last level from going
        // blocky when you push past it.
        'raster-contrast': 0.12,
        'raster-saturation': 0.12,
        'raster-resampling': 'linear',
        'raster-fade-duration': 200,
      },
    },
    // Water first, so a lake name never lands on top of a street name.
    {
      id: 'label-water',
      type: 'symbol',
      source: VECTOR_SOURCE_ID,
      'source-layer': 'water_name',
      layout: {
        'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
        'text-font': LABEL_FONT,
        'text-size': 12,
        'text-letter-spacing': 0.1,
      },
      paint: {
        'text-color': '#cfe8ff',
        'text-halo-color': 'rgba(4, 16, 32, 0.85)',
        'text-halo-width': 1.3,
      },
    },
    {
      id: 'label-street',
      type: 'symbol',
      source: VECTOR_SOURCE_ID,
      'source-layer': 'transportation_name',
      // Street names are noise until you are close enough to walk them.
      minzoom: 14,
      layout: {
        'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
        'text-font': LABEL_FONT,
        'text-size': 11,
        'symbol-placement': 'line',
        'text-rotation-alignment': 'map',
      },
      paint: {
        'text-color': '#f2f5f8',
        'text-halo-color': 'rgba(4, 16, 32, 0.9)',
        'text-halo-width': 1.4,
      },
    },
    {
      id: 'label-place',
      type: 'symbol',
      source: VECTOR_SOURCE_ID,
      'source-layer': 'place',
      filter: ['in', ['get', 'class'], ['literal', ['city', 'town', 'village', 'suburb', 'neighbourhood']]],
      layout: {
        'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
        'text-font': LABEL_FONT,
        // Cities read as headings, neighbourhoods as captions.
        'text-size': [
          'match',
          ['get', 'class'],
          'city', 16,
          'town', 13,
          11,
        ],
        'text-letter-spacing': 0.06,
        'text-max-width': 8,
      },
      paint: {
        'text-color': '#ffffff',
        'text-halo-color': 'rgba(4, 16, 32, 0.9)',
        'text-halo-width': 1.6,
      },
    },
  ],
};

export interface Basemap {
  id: BasemapId;
  label: string;
  /** A URL for a hosted style, or an inline style object. */
  style: string | maplibregl.StyleSpecification;
}

export const BASEMAPS: Record<BasemapId, Basemap> = {
  streets: { id: 'streets', label: 'Map', style: STREETS_STYLE_URL },
  satellite: { id: 'satellite', label: 'Satellite', style: SATELLITE_STYLE },
};
