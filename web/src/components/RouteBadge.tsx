import type { RouteSummary } from '../lib/api.ts';
import { readableTextColor } from '../lib/format.ts';

/**
 * The coloured route pill.
 *
 * Takes its colour from the agency's own GTFS so a Blue Line badge is the same
 * blue riders see on the platform, but recomputes the text colour for contrast
 * rather than trusting route_text_color, which feeds often get wrong.
 */
export function RouteBadge({ route, size = 'normal' }: { route: RouteSummary; size?: 'normal' | 'small' }) {
  const background = `#${route.color}`;
  return (
    <span
      className={`route-badge route-badge--${size}`}
      style={{ background, color: readableTextColor(route.color) }}
      title={route.longName || route.shortName}
    >
      {route.shortName}
    </span>
  );
}
