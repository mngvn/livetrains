/**
 * Which route the pointer means, when it rests on the network.
 *
 * Routes share streets: downtown a dozen can run down one block, each drawn
 * on top of the last. The one meant is the one a rider would name first (a
 * train over a branded bus line over an ordinary bus), then the one nearest
 * the pointer. The rest on that stretch are kept too, so the tooltip can say
 * what else runs there.
 */

type Px = [number, number];

export interface RouteHit {
  routeId: string;
  /** The line's tier, from the network underlay: 'rail', 'branded' or 'bus'. */
  tier: string;
  /** Screen pixels from the pointer to the line. */
  distance: number;
}

export interface RouteHover {
  routeId: string;
  /** The other routes on the same stretch, in the same order of preference. */
  others: string[];
}

const TIER_ORDER: Record<string, number> = { rail: 0, branded: 1, bus: 2 };

export function pickRoute(hits: readonly RouteHit[]): RouteHover | null {
  // A route is drawn once per direction; keep each route's nearer line.
  const best = new Map<string, RouteHit>();
  for (const hit of hits) {
    if (!hit.routeId) continue;
    const held = best.get(hit.routeId);
    if (!held || hit.distance < held.distance) best.set(hit.routeId, hit);
  }
  const ranked = [...best.values()].sort(
    (a, b) => (TIER_ORDER[a.tier] ?? 3) - (TIER_ORDER[b.tier] ?? 3) || a.distance - b.distance,
  );
  if (ranked.length === 0) return null;
  return { routeId: ranked[0].routeId, others: ranked.slice(1).map((hit) => hit.routeId) };
}

/** Pixels from a point to the nearest place on any of some screen-space lines. */
export function distanceToLines(lines: readonly (readonly Px[])[], point: Px): number {
  let best = Infinity;
  for (const line of lines) {
    if (line.length === 1) best = Math.min(best, Math.hypot(line[0][0] - point[0], line[0][1] - point[1]));
    for (let i = 0; i < line.length - 1; i++) {
      const [ax, ay] = line[i];
      const [bx, by] = line[i + 1];
      const dx = bx - ax;
      const dy = by - ay;
      const lengthSquared = dx * dx + dy * dy;
      const t = lengthSquared > 0 ? Math.min(1, Math.max(0, ((point[0] - ax) * dx + (point[1] - ay) * dy) / lengthSquared)) : 0;
      best = Math.min(best, Math.hypot(ax + dx * t - point[0], ay + dy * t - point[1]));
    }
  }
  return best;
}
