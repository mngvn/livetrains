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
 * attribution control. Imagery alone is disorienting for transit — you cannot
 * read a street name off a roof — so a transparent reference layer of
 * boundaries and place labels goes over the top.
 */
const ESRI_IMAGERY =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const ESRI_REFERENCE =
  'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}';

export const ESRI_ATTRIBUTION =
  'Imagery &copy; Esri, Maxar, Earthstar Geographics, and the GIS User Community';

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

/** The satellite style, assembled here rather than fetched. */
export const SATELLITE_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
  sources: {
    'esri-imagery': {
      type: 'raster',
      tiles: [ESRI_IMAGERY],
      tileSize: 256,
      maxzoom: 19,
      attribution: ESRI_ATTRIBUTION,
    },
    'esri-reference': {
      type: 'raster',
      tiles: [ESRI_REFERENCE],
      tileSize: 256,
      maxzoom: 19,
    },
    // Present only so 3D mode has building footprints to extrude. If it fails
    // to load, imagery and transit data are unaffected — there are simply no
    // buildings, which is exactly what plain satellite mode looks like.
    [VECTOR_SOURCE_ID]: { type: 'vector', url: OPENFREEMAP_TILES },
  },
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': '#0b1220' } },
    { id: 'esri-imagery', type: 'raster', source: 'esri-imagery' },
    {
      id: 'esri-reference',
      type: 'raster',
      source: 'esri-reference',
      // Labels read as a caption over the photo rather than part of it.
      paint: { 'raster-opacity': 0.85 },
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
