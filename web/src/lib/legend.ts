import type { RouteSummary } from './api.ts';

/**
 * Splits routes into the branded lines worth naming and the generic mass.
 *
 * Nearly every local bus in a system shares one colour, while rail lines and
 * BRT corridors each get their own — that is the whole point of branding them.
 * So the most common colour is treated as the "ordinary bus" bucket, and
 * everything else is a line a rider might recognise on sight and want
 * explained. Deriving it this way rather than hardcoding keeps the legend
 * correct when an agency recolours a line, and works unchanged in any city.
 */
export interface BrandedLines {
  /** Distinctly coloured routes, rail first, capped for legibility. */
  branded: RouteSummary[];
  /** The colour shared by the bulk of ordinary routes, if there is one. */
  genericColor: string | null;
  /** How many routes share that colour. */
  genericCount: number;
}

/** Below this, a shared colour is a coincidence rather than a house style. */
const GENERIC_THRESHOLD = 4;
/** More than this many named lines stops being a legend and becomes a list. */
const MAX_BRANDED = 10;

export function splitBrandedLines(routes: RouteSummary[]): BrandedLines {
  if (routes.length === 0) return { branded: [], genericColor: null, genericCount: 0 };

  const byColor = new Map<string, number>();
  for (const route of routes) {
    byColor.set(route.color, (byColor.get(route.color) ?? 0) + 1);
  }

  let genericColor: string | null = null;
  let genericCount = 0;
  for (const [color, count] of byColor) {
    if (count > genericCount) {
      genericCount = count;
      genericColor = color;
    }
  }

  // In a small feed every route may be distinctly coloured; there is no
  // generic bucket to collapse, so just name what fits.
  if (genericCount < GENERIC_THRESHOLD) {
    return { branded: routes.slice(0, MAX_BRANDED + 2), genericColor: null, genericCount: 0 };
  }

  const modeRank: Record<string, number> = { rail: 0, metro: 1, tram: 1, ferry: 2, bus: 3 };
  const branded = routes
    .filter((route) => route.color !== genericColor)
    .sort((a, b) => (modeRank[a.mode] ?? 4) - (modeRank[b.mode] ?? 4))
    .slice(0, MAX_BRANDED);

  return { branded, genericColor, genericCount };
}
