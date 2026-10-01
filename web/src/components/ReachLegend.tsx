import { ISOCHRONE_BANDS } from '../lib/isochrone.ts';
import { clockTime } from '../lib/format.ts';

/**
 * The key to the shaded map: which shade is which band, from where, and
 * leaving when. Sits over the bottom of the map with a way to clear it.
 */
export function ReachLegend({
  stopName,
  departAt,
  onClose,
}: {
  stopName: string;
  departAt: number;
  onClose: () => void;
}) {
  return (
    <div className="reach-legend" role="status">
      <div className="reach-legend__text">
        <span className="reach-legend__label">Reachable from {stopName}</span>
        <span className="reach-legend__detail">Leaving {clockTime(departAt)} · live times, walks included</span>
      </div>
      <ol className="reach-legend__bands" aria-label="Minutes">
        {ISOCHRONE_BANDS.map((band) => (
          <li key={band} className={`reach-legend__band is-${band}`}>
            <span className="reach-legend__swatch" aria-hidden="true" />
            {band} min
          </li>
        ))}
      </ol>
      <button type="button" className="icon-button" onClick={onClose} aria-label="Clear the reach map">
        ×
      </button>
    </div>
  );
}
