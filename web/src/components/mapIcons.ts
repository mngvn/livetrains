import type * as maplibregl from 'maplibre-gl';

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
 * shape, route by colour, and heading by a nose on the plate itself.
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

/**
 * Buses and everything unclassified: a disc.
 *
 * The plate the pictogram sits on. At metro zoom the pictogram is dropped and
 * the plate alone carries the mode by its outline — round for a bus, square
 * for a train — because a silhouette at six pixels is mush.
 */
const drawBus: Draw = (ctx, { width: size }) => {
  const c = size / 2;
  ctx.beginPath();
  ctx.arc(c, c, size * 0.3, 0, Math.PI * 2);
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
  const half = size * 0.27;
  const radius = size * 0.05;
  ctx.beginPath();
  ctx.roundRect(c - half, c - half, half * 2, half * 2, radius);
  ctx.fill();
};

/**
 * The bus pictogram, seen from the front as on every bus-stop sign: a body
 * with a full-width windscreen, two headlamps, and wheels below.
 *
 * Drawn as an SDF like the plates, so it can be coloured per route — in the
 * route's own text colour, which the agency chose to read on that route's
 * colour, so a pale line like Gold still gets a legible glyph.
 */
const drawBusGlyph: Draw = (ctx, { width: size }) => {
  const u = size / 40;
  ctx.beginPath();
  ctx.roundRect(13.4 * u, 11 * u, 13.2 * u, 15.4 * u, 2.6 * u);
  ctx.fill();
  // Wheels.
  ctx.fillRect(14.6 * u, 25 * u, 2.6 * u, 3.4 * u);
  ctx.fillRect(22.8 * u, 25 * u, 2.6 * u, 3.4 * u);
  // Windscreen and lamps, cut out of the body.
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath();
  ctx.roundRect(15 * u, 13.4 * u, 10 * u, 6.2 * u, 0.9 * u);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(16.4 * u, 22.6 * u, 1.05 * u, 0, Math.PI * 2);
  ctx.arc(23.6 * u, 22.6 * u, 1.05 * u, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
};

/**
 * The tram pictogram: a rounded front with a tall windscreen, a pantograph
 * on the roof, and a bogie underneath — the light-rail symbol on Twin Cities
 * station signs, reduced to what survives at icon size.
 */
const drawTrainGlyph: Draw = (ctx, { width: size }) => {
  const u = size / 40;
  // Pantograph: a shallow V over the roof.
  ctx.lineWidth = 1.5 * u;
  ctx.strokeStyle = '#fff';
  ctx.beginPath();
  ctx.moveTo(16.6 * u, 8.6 * u);
  ctx.lineTo(20 * u, 11.6 * u);
  ctx.lineTo(23.4 * u, 8.6 * u);
  ctx.stroke();
  ctx.beginPath();
  ctx.roundRect(13.6 * u, 11.2 * u, 12.8 * u, 15.4 * u, [4.2 * u, 4.2 * u, 1.6 * u, 1.6 * u]);
  ctx.fill();
  ctx.fillRect(15.6 * u, 26 * u, 8.8 * u, 2.6 * u);
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath();
  ctx.roundRect(15.4 * u, 13.8 * u, 9.2 * u, 6.4 * u, [2.6 * u, 2.6 * u, 0.6 * u, 0.6 * u]);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(16.8 * u, 23 * u, 1 * u, 0, Math.PI * 2);
  ctx.arc(23.2 * u, 23 * u, 1 * u, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
};

/**
 * A small rectangular plate that stretches to fit text, for route numbers:
 * the badge beside a vehicle and the row of routes under a stop.
 *
 * Near-square corners on purpose — transit signage plates are cut, not
 * pillowed.
 */
const BADGE = { width: 20, height: 14 };
const drawBadge: Draw = (ctx, { width, height }) => {
  ctx.beginPath();
  ctx.roundRect(1, 1, width - 2, height - 2, 1.6);
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
 * A plate with its heading built in: the same disc or square, with a nose
 * running out of the top edge towards where the vehicle is going.
 *
 * One silhouette rather than a plate and an arrow drawn separately, so the
 * outline the map draws round it wraps both, and the nose reads as part of
 * the vehicle instead of a mark floating beside it. The image is rotated to
 * the vehicle's bearing; the pictogram on top stays upright.
 */
function withNose(plate: Draw): Draw {
  return (ctx, box) => {
    plate(ctx, box);
    const size = box.width;
    const c = size / 2;
    ctx.beginPath();
    ctx.moveTo(c, size * 0.035);
    ctx.lineTo(c + size * 0.19, size * 0.34);
    ctx.lineTo(c - size * 0.19, size * 0.34);
    ctx.closePath();
    ctx.fill();
  };
}

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

/**
 * Aircraft, seen from above with the nose up, so `icon-rotate` turns them to
 * their track. Silhouettes rather than plates on purpose: a thin outline has
 * a fraction of a plate's visual weight, which keeps planes in the
 * background of a map that is about buses and trains, and the shape alone
 * says "not transit" before any colour does.
 */

/** An airliner or business jet: swept wings, tailplane. */
const drawJet: Draw = (ctx, { width: size }) => {
  const u = size / 40;
  ctx.beginPath();
  ctx.roundRect(18.5 * u, 4.5 * u, 3 * u, 30 * u, 1.5 * u);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(20 * u, 14.5 * u);
  ctx.lineTo(35 * u, 23 * u);
  ctx.lineTo(35 * u, 25.6 * u);
  ctx.lineTo(20 * u, 21.6 * u);
  ctx.lineTo(5 * u, 25.6 * u);
  ctx.lineTo(5 * u, 23 * u);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(20 * u, 29 * u);
  ctx.lineTo(26.5 * u, 33.2 * u);
  ctx.lineTo(26.5 * u, 35.2 * u);
  ctx.lineTo(20 * u, 33.6 * u);
  ctx.lineTo(13.5 * u, 35.2 * u);
  ctx.lineTo(13.5 * u, 33.2 * u);
  ctx.closePath();
  ctx.fill();
};

/** A light aircraft or glider: straight wings, the silhouette of a Cessna. */
const drawLightPlane: Draw = (ctx, { width: size }) => {
  const u = size / 40;
  ctx.beginPath();
  ctx.roundRect(18.6 * u, 7 * u, 2.8 * u, 26 * u, 1.4 * u);
  ctx.fill();
  ctx.beginPath();
  ctx.roundRect(6 * u, 14 * u, 28 * u, 3.6 * u, 1.2 * u);
  ctx.fill();
  ctx.beginPath();
  ctx.roundRect(14 * u, 29.4 * u, 12 * u, 2.6 * u, 1 * u);
  ctx.fill();
};

/** A helicopter: cabin, tail boom, and the rotor as a crossed pair of blades. */
const drawHelicopter: Draw = (ctx, { width: size }) => {
  const u = size / 40;
  ctx.beginPath();
  ctx.ellipse(20 * u, 18 * u, 4.2 * u, 6.2 * u, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillRect(19.1 * u, 22 * u, 1.8 * u, 12 * u);
  ctx.fillRect(16.4 * u, 32.6 * u, 7.2 * u, 1.8 * u);
  ctx.lineWidth = 1.8 * u;
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#fff';
  ctx.beginPath();
  ctx.moveTo(8 * u, 6 * u);
  ctx.lineTo(32 * u, 30 * u);
  ctx.moveTo(32 * u, 6 * u);
  ctx.lineTo(8 * u, 30 * u);
  ctx.stroke();
};

interface IconSpec {
  draw: Draw;
  box?: Box;
  /** For images that stretch to fit text: which bands stretch, and where text goes. */
  stretch?: {
    stretchX: [number, number][];
    stretchY: [number, number][];
    content: [number, number, number, number];
  };
}

/** Stretch bands in buffer pixels, which are PIXEL_RATIO times the drawn size. */
const px = (n: number) => n * PIXEL_RATIO;

export const VEHICLE_ICONS: Record<string, IconSpec> = {
  'vehicle-bus': { draw: drawBus },
  'vehicle-rail': { draw: drawRail },
  'vehicle-ferry': { draw: drawFerry },
  'vehicle-bus-dir': { draw: withNose(drawBus) },
  'vehicle-rail-dir': { draw: withNose(drawRail) },
  'vehicle-ferry-dir': { draw: withNose(drawFerry) },
  'glyph-bus': { draw: drawBusGlyph },
  'glyph-train': { draw: drawTrainGlyph },
  'vehicle-beam': { draw: drawBeam, box: { width: BEAM_WIDTH, height: BEAM_HEIGHT } },
  'plane-jet': { draw: drawJet },
  'plane-light': { draw: drawLightPlane },
  'plane-heli': { draw: drawHelicopter },
  badge: {
    draw: drawBadge,
    box: BADGE,
    stretch: {
      stretchX: [[px(4), px(BADGE.width - 4)]],
      stretchY: [[px(4), px(BADGE.height - 4)]],
      content: [px(3), px(2), px(BADGE.width - 3), px(BADGE.height - 2)],
    },
  },
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
      map.addImage(id, makeSdf(spec.draw, spec.box), { sdf: true, pixelRatio: PIXEL_RATIO, ...spec.stretch });
    } catch (err) {
      // A missing icon degrades the map; it should not break it.
      console.warn(`livetrains: could not register marker "${id}"`, err);
    }
  }
}

/** The pictogram for a mode, drawn on its plate once the plate is big enough. */
export const MODE_TO_GLYPH: maplibregl.ExpressionSpecification = [
  'match',
  ['get', 'mode'],
  ['rail', 'tram', 'metro', 'funicular', 'cable'],
  'glyph-train',
  'glyph-bus',
];

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

/**
 * The marker for a vehicle: with a nose pointing its way when the feed says
 * which way that is, and a plain plate when it does not — an arrow on a
 * vehicle of unknown heading would be a confident lie.
 */
export const VEHICLE_ICON: maplibregl.ExpressionSpecification = [
  'case',
  ['boolean', ['get', 'hasHeading'], false],
  [
    'match',
    ['get', 'mode'],
    ['rail', 'tram', 'metro', 'funicular', 'cable'],
    'vehicle-rail-dir',
    'ferry',
    'vehicle-ferry-dir',
    'vehicle-bus-dir',
  ],
  MODE_TO_ICON,
];

/** The silhouette for an aircraft, by the `shape` its feature carries. */
export const PLANE_ICON: maplibregl.ExpressionSpecification = [
  'match',
  ['get', 'shape'],
  'light',
  'plane-light',
  'heli',
  'plane-heli',
  'plane-jet',
];
