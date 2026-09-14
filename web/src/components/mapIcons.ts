import type maplibregl from 'maplibre-gl';

/**
 * Vehicle marker artwork, generated at runtime.
 *
 * These are registered as **SDF** images, which is what lets one drawing serve
 * every route: MapLibre recolours an SDF icon per feature from `icon-color`,
 * so 130 route colours need one shape rather than 130 bitmaps. SDF icons are
 * also the only ones that can take a halo, which is what keeps a dark-coloured
 * marker legible against a dark basemap and vice versa.
 *
 * The shapes are deliberately blunt. At the size a vehicle occupies on a city
 * map — eight or ten pixels — a detailed train silhouette is mush, whereas a
 * square reads as "not a circle" instantly. So mode is carried by outline
 * shape, route by colour, and heading by a separate rotating arrow.
 */

/** Marker artwork is drawn at this nominal CSS size; `icon-size` scales it. */
const ICON_SIZE = 40;
/** The beam is tall and narrow, so it gets its own canvas shape. */
const BEAM_WIDTH = 26;
const BEAM_HEIGHT = 176;
/** Supersampled so the distance field has sub-pixel accuracy. */
const PIXEL_RATIO = 2;
/**
 * How far the distance field spreads, in buffer pixels.
 *
 * This is the width of the gradient MapLibre antialiases across, and also the
 * headroom a halo can occupy — too small and halos clip, too large and the
 * shape's edge goes soft.
 */
const SPREAD = 7;
/**
 * Where the shape's edge sits in the encoded alpha.
 *
 * Matches the convention MapLibre's SDF shader expects (the same one TinySDF
 * emits for glyphs): the outline lands at alpha ≈ 191, not 128.
 */
const CUTOFF = 0.25;

interface Box {
  width: number;
  height: number;
}

type Draw = (ctx: CanvasRenderingContext2D, box: Box) => void;

export interface SdfImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/**
 * Renders a shape into a signed distance field.
 *
 * Distances are stamped outward from the shape's boundary rather than measured
 * for every pixel against every boundary pixel: only the band within `SPREAD`
 * of the edge has a value that is not simply "fully inside" or "fully
 * outside", so that is the only band worth computing.
 */
function makeSdf(draw: Draw, box: Box = { width: ICON_SIZE, height: ICON_SIZE }): SdfImage {
  const w = Math.round(box.width * PIXEL_RATIO);
  const h = Math.round(box.height * PIXEL_RATIO);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas is unavailable');

  ctx.scale(PIXEL_RATIO, PIXEL_RATIO);
  ctx.fillStyle = '#fff';
  draw(ctx, box);

  const pixels = ctx.getImageData(0, 0, w, h).data;
  const inside = new Uint8Array(w * h);
  for (let i = 0; i < inside.length; i++) inside[i] = pixels[i * 4 + 3] > 127 ? 1 : 0;

  // Unsigned distance to the boundary, seeded at Infinity.
  const distance = new Float32Array(w * h).fill(Number.POSITIVE_INFINITY);
  const reach = Math.ceil(SPREAD * PIXEL_RATIO) + 1;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const index = y * w + x;
      if (!inside[index]) continue;
      // A boundary pixel is one inside the shape touching the outside.
      const edge =
        x === 0 ||
        y === 0 ||
        x === w - 1 ||
        y === h - 1 ||
        !inside[index - 1] ||
        !inside[index + 1] ||
        !inside[index - w] ||
        !inside[index + w];
      if (!edge) continue;

      for (let dy = -reach; dy <= reach; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -reach; dx <= reach; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const d = Math.sqrt(dx * dx + dy * dy);
          const target = ny * w + nx;
          if (d < distance[target]) distance[target] = d;
        }
      }
    }
  }

  const data = new Uint8ClampedArray(w * h * 4);
  const radius = SPREAD * PIXEL_RATIO;
  for (let i = 0; i < inside.length; i++) {
    // Negative inside, positive outside — the sign is what makes it *signed*.
    const signed = (inside[i] ? -1 : 1) * (Number.isFinite(distance[i]) ? distance[i] : radius + 1);
    const alpha = 255 - 255 * (signed / radius + CUTOFF);
    const o = i * 4;
    data[o] = 255;
    data[o + 1] = 255;
    data[o + 2] = 255;
    data[o + 3] = Math.max(0, Math.min(255, alpha));
  }

  return { width: w, height: h, data };
}

// ---------------------------------------------------------------------------
// The shapes
// ---------------------------------------------------------------------------

/** Buses and everything unclassified: a plain disc. */
const drawBus: Draw = (ctx, { width: size }) => {
  const c = size / 2;
  ctx.beginPath();
  ctx.arc(c, c, size * 0.26, 0, Math.PI * 2);
  ctx.fill();
};

/**
 * Rail: a rounded square.
 *
 * Chosen because it stays distinguishable from a disc at any size a vehicle is
 * drawn — the corners survive when a glyph would not.
 */
const drawRail: Draw = (ctx, { width: size }) => {
  const c = size / 2;
  const half = size * 0.24;
  const radius = size * 0.07;
  ctx.beginPath();
  ctx.roundRect(c - half, c - half, half * 2, half * 2, radius);
  ctx.fill();
};

/** Ferries: a diamond, since they follow neither rails nor streets. */
const drawFerry: Draw = (ctx, { width: size }) => {
  const c = size / 2;
  const r = size * 0.28;
  ctx.beginPath();
  ctx.moveTo(c, c - r);
  ctx.lineTo(c + r, c);
  ctx.lineTo(c, c + r);
  ctx.lineTo(c - r, c);
  ctx.closePath();
  ctx.fill();
};

/**
 * The heading arrow.
 *
 * Drawn near the top of the canvas rather than at its centre, so that rotating
 * the icon about its own centre swings the arrow around the vehicle. Baking
 * the offset into the artwork this way avoids depending on how `icon-offset`
 * and `icon-rotate` compose.
 */
const drawHeading: Draw = (ctx, { width: size }) => {
  const c = size / 2;
  const tip = size * 0.03;
  const base = size * 0.28;
  const halfWidth = size * 0.15;
  // A plain triangle rather than a notched chevron: the notch is invisible at
  // the five or six pixels this occupies on screen, and only costs contrast.
  // The base sits inside the marker so the arrow reads as attached to the
  // vehicle rather than floating near it.
  ctx.beginPath();
  ctx.moveTo(c, tip);
  ctx.lineTo(c + halfWidth, base);
  ctx.lineTo(c - halfWidth, base);
  ctx.closePath();
  ctx.fill();
};

/**
 * The beam: a shaft of the route's colour rising from the vehicle.
 *
 * Zoomed out to a whole metro, a vehicle is a four-pixel dot on a pale map and
 * genuinely hard to find. A vertical streak is far easier for an eye to catch,
 * and where several overlap they pool into a wash that reads as "lots of
 * service here" — so the beams double as a density map.
 *
 * It rises in *screen* space rather than as true 3D geometry. The map is
 * top-down, where an extruded pillar would be an invisible flat square, and a
 * screen-space shaft also survives at any pitch without forcing a tilted view.
 *
 * The taper does the work a gradient would: an SDF is thresholded by the
 * shader, so alpha cannot fade along the shaft's length, but narrowing it to a
 * point reads as a fade anyway.
 */
const drawBeam: Draw = (ctx, { width, height }) => {
  const c = width / 2;
  const baseHalf = width * 0.2;
  const tipHalf = width * 0.035;
  // Leave a pixel of headroom so the tip is not clipped by the canvas edge.
  const top = 1.5;

  ctx.beginPath();
  ctx.moveTo(c - baseHalf, height);
  ctx.lineTo(c - tipHalf, top);
  ctx.lineTo(c + tipHalf, top);
  ctx.lineTo(c + baseHalf, height);
  ctx.closePath();
  ctx.fill();
};

interface IconSpec {
  draw: Draw;
  box?: Box;
}

export const VEHICLE_ICONS: Record<string, IconSpec> = {
  'vehicle-bus': { draw: drawBus },
  'vehicle-rail': { draw: drawRail },
  'vehicle-ferry': { draw: drawFerry },
  'vehicle-heading': { draw: drawHeading },
  'vehicle-beam': { draw: drawBeam, box: { width: BEAM_WIDTH, height: BEAM_HEIGHT } },
};

/**
 * Registers every marker image on a map style.
 *
 * Safe to call again after a style change, which drops all images along with
 * the layers that use them.
 */
export function registerVehicleIcons(map: maplibregl.Map): void {
  for (const [id, spec] of Object.entries(VEHICLE_ICONS)) {
    if (map.hasImage(id)) continue;
    try {
      map.addImage(id, makeSdf(spec.draw, spec.box), { sdf: true, pixelRatio: PIXEL_RATIO });
    } catch (err) {
      // A missing icon degrades the map; it should not break it.
      console.warn(`livetrains: could not register marker "${id}"`, err);
    }
  }
}

/** Maps a GTFS mode onto the marker shape that represents it. */
export const MODE_TO_ICON: maplibregl.ExpressionSpecification = [
  'match',
  ['get', 'mode'],
  ['rail', 'tram', 'metro', 'funicular', 'cable'],
  'vehicle-rail',
  'ferry',
  'vehicle-ferry',
  'vehicle-bus',
];
