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

export function groupVehicles(points: GroupInput[], radius: number, exclude?: string | null): Grouping {
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
  const groups: VehicleGroup[] = [];
  const grouped = new Set<string>();
  const r2 = radius * radius;

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

    let lon = 0;
    let lat = 0;
    let rail = 0;
    for (const m of members) {
      taken[m] = 1;
      const p = points[m];
      lon += p.lon;
      lat += p.lat;
      if (p.rail) rail++;
      grouped.add(p.id);
    }
    groups.push({ lon: lon / members.length, lat: lat / members.length, count: members.length, rail });
  }

  return { groups, grouped };
}
