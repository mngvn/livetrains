/**
 * Gathers vehicles that sit on top of each other on screen into counted
 * groups.
 *
 * Done here rather than by the map's own clustering for one reason: smooth
 * motion. A clustered map source has to be re-indexed to move anything in it,
 * which is affordable once a second but not sixty times — so with map-side
 * clustering every lone vehicle at metro zoom stepped once a second instead
 * of gliding. Working out *membership* here, a couple of times a second, lets
 * the vehicles that are not in a group stay on the live per-frame layer, and
 * only the group discs move at the slower rate.
 *
 * Distances are in screen pixels, so the grouping follows what the eye sees
 * at the current zoom rather than any fixed distance on the ground.
 */

export interface GroupInput {
  id: string;
  /** Screen position, pixels. */
  x: number;
  y: number;
  lon: number;
  lat: number;
  rail: boolean;
}

export interface VehicleGroup {
  lon: number;
  lat: number;
  count: number;
  /** How many of them are trains, for tinting the disc. */
  rail: number;
}

export interface Grouping {
  groups: VehicleGroup[];
  /** Ids of every vehicle drawn as part of a group rather than on its own. */
  grouped: Set<string>;
}

/** Fewer than this close together stay individual: two dots are still readable as two. */
export const MIN_GROUP = 3;

/** How much of the screen a group's disc and a lone vehicle's plate cover, in pixels. */
export interface Footprint {
  /** A disc's radius for a group of `count`. */
  disc: (count: number) => number;
  /** Half a lone vehicle's plate. */
  plate: number;
}

interface Gathering {
  /** Sums over the members, for their average. */
  x: number;
  y: number;
  lon: number;
  lat: number;
  count: number;
  rail: number;
}

/**
 * Groups every cluster of at least `MIN_GROUP` vehicles within `radius`
 * pixels of each other.
 *
 * Given a `footprint`, the result is also tidied so that nothing drawn sits
 * on a disc: groups whose discs would touch become one group, and a lone
 * vehicle whose plate would land on a disc joins it. Without that, the
 * counts of neighbouring discs ran together into one number, and a tap on a
 * disc went to whichever bus was parked over its edge.
 */
export function groupVehicles(
  points: GroupInput[],
  radius: number,
  exclude?: string | null,
  footprint?: Footprint,
): Grouping {
  const cell = radius;
  const grid = new Map<string, number[]>();
  const key = (cx: number, cy: number) => `${cx}:${cy}`;
  // Stable order, so the same vehicles group the same way from one pass to
  // the next and the discs do not flicker between arrangements.
  const order = points
    .map((point, index) => ({ point, index }))
    .filter(({ point }) => point.id !== exclude)
    .sort((a, b) => (a.point.id < b.point.id ? -1 : a.point.id > b.point.id ? 1 : 0));

  for (const { point, index } of order) {
    const k = key(Math.floor(point.x / cell), Math.floor(point.y / cell));
    const list = grid.get(k);
    if (list) list.push(index);
    else grid.set(k, [index]);
  }

  const taken = new Uint8Array(points.length);
  const gatherings: Gathering[] = [];
  const grouped = new Set<string>();
  const r2 = radius * radius;
  const join = (g: Gathering, m: number) => {
    taken[m] = 1;
    const p = points[m];
    g.x += p.x;
    g.y += p.y;
    g.lon += p.lon;
    g.lat += p.lat;
    g.count += 1;
    if (p.rail) g.rail++;
    grouped.add(p.id);
  };

  for (const { point, index } of order) {
    if (taken[index]) continue;
    const cx = Math.floor(point.x / cell);
    const cy = Math.floor(point.y / cell);
    const members: number[] = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const other of grid.get(key(cx + dx, cy + dy)) ?? []) {
          if (taken[other]) continue;
          const o = points[other];
          const ddx = o.x - point.x;
          const ddy = o.y - point.y;
          if (ddx * ddx + ddy * ddy <= r2) members.push(other);
        }
      }
    }
    if (members.length < MIN_GROUP) continue;

    const g: Gathering = { x: 0, y: 0, lon: 0, lat: 0, count: 0, rail: 0 };
    for (const m of members) join(g, m);
    gatherings.push(g);
  }

  if (footprint) {
    // Each pass can only shrink the number of groups or the number of lone
    // vehicles, so this ends; in practice within two or three passes.
    for (let changed = true; changed; ) {
      changed = false;
      for (let i = 0; i < gatherings.length; i++) {
        for (let j = i + 1; j < gatherings.length; j++) {
          const a = gatherings[i];
          const b = gatherings[j];
          const reach = footprint.disc(a.count) + footprint.disc(b.count);
          if (Math.hypot(a.x / a.count - b.x / b.count, a.y / a.count - b.y / b.count) >= reach) continue;
          a.x += b.x;
          a.y += b.y;
          a.lon += b.lon;
          a.lat += b.lat;
          a.count += b.count;
          a.rail += b.rail;
          gatherings.splice(j, 1);
          // `a` has moved and grown: check it against everything again.
          j = i;
          changed = true;
        }
      }
      for (const { point, index } of order) {
        if (taken[index]) continue;
        const g = gatherings.find(
          (g) => Math.hypot(point.x - g.x / g.count, point.y - g.y / g.count) < footprint.disc(g.count) + footprint.plate,
        );
        if (!g) continue;
        join(g, index);
        changed = true;
      }
    }
  }

  const groups = gatherings.map(
    (g): VehicleGroup => ({ lon: g.lon / g.count, lat: g.lat / g.count, count: g.count, rail: g.rail }),
  );
  return { groups, grouped };
}
