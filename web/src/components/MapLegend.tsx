import { useMemo, useState } from 'react';
import type { RouteSummary } from '../lib/api.ts';
import { modeLabel, readableTextColor } from '../lib/format.ts';
import { splitBrandedLines } from '../lib/legend.ts';

/**
 * A key to what is drawn on the map.
 *
 * Two halves, because there are two different "what's that?" questions. The
 * symbols half explains the shapes — a dot is a vehicle, a ring is a stop, a
 * dashed line is walking. The lines half answers the one riders actually ask:
 * which colour is which line.
 *
 * The lines half is derived from the loaded feed rather than hardcoded, so it
 * stays correct when an agency recolours a line, and works unchanged for any
 * other city the app is pointed at.
 */

export function MapLegend({ routes }: { routes: RouteSummary[] }) {
  const [open, setOpen] = useState(false);
  const { branded, genericColor, genericCount } = useMemo(() => splitBrandedLines(routes), [routes]);

  return (
    <div className={`legend${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className="legend__toggle"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span className="legend__toggle-icon" aria-hidden="true">
          <svg viewBox="0 0 16 16" width="14" height="14">
            <circle cx="4" cy="4" r="2.5" fill="currentColor" />
            <circle cx="4" cy="12" r="2.5" fill="currentColor" />
            <rect x="8.5" y="2.75" width="6" height="2.5" rx="1.25" fill="currentColor" />
            <rect x="8.5" y="10.75" width="6" height="2.5" rx="1.25" fill="currentColor" />
          </svg>
        </span>
        Legend
      </button>

      {open && (
        <div className="legend__panel">
          <section className="legend__section">
            <h3 className="legend__heading">On the map</h3>
            <ul className="legend__items">
              <li className="legend__item">
                <Swatch kind="vehicle" />
                <span>
                  Live vehicle
                  <em>coloured by its route</em>
                </span>
              </li>
              <li className="legend__item">
                <Swatch kind="stop" />
                <span>
                  Stop
                  <em>tap for departures</em>
                </span>
              </li>
              <li className="legend__item">
                <Swatch kind="ride" />
                <span>Your ride</span>
              </li>
              <li className="legend__item">
                <Swatch kind="walk" />
                <span>Walking</span>
              </li>
              <li className="legend__item">
                <Swatch kind="origin" />
                <span>Start</span>
              </li>
              <li className="legend__item">
                <Swatch kind="destination" />
                <span>Destination</span>
              </li>
            </ul>
          </section>

          {(branded.length > 0 || genericColor) && (
            <section className="legend__section">
              <h3 className="legend__heading">Lines</h3>
              <ul className="legend__items">
                {branded.map((route) => (
                  <li className="legend__item" key={route.id}>
                    <span
                      className="legend__badge"
                      style={{ background: `#${route.color}`, color: readableTextColor(route.color) }}
                    >
                      {route.shortName}
                    </span>
                    <span>
                      {/* Clamped to one line: a legend that wraps turns into a
                          wall of text and stops being scannable. The full name
                          is still there on hover. */}
                      <span className="legend__name" title={route.longName || route.shortName}>
                        {route.longName || route.shortName}
                      </span>
                      <em>{modeLabel(route.mode)}</em>
                    </span>
                  </li>
                ))}

                {genericColor && (
                  <li className="legend__item">
                    <span
                      className="legend__badge legend__badge--generic"
                      style={{ background: `#${genericColor}`, color: readableTextColor(genericColor) }}
                      aria-hidden="true"
                    >
                      ●
                    </span>
                    <span>
                      Local bus routes
                      <em>{genericCount} routes share this colour</em>
                    </span>
                  </li>
                )}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Draws the same mark the map draws.
 *
 * Deliberately inline SVG copying the map layer's geometry — a legend that
 * only approximates the symbol it explains is worse than none, because the
 * reader has to work out whether the difference means something.
 */
function Swatch({ kind }: { kind: 'vehicle' | 'stop' | 'ride' | 'walk' | 'origin' | 'destination' }) {
  switch (kind) {
    case 'vehicle':
      return (
        <svg className="legend__swatch" viewBox="0 0 24 16" aria-hidden="true">
          <circle cx="12" cy="8" r="6" fill="#0b5fa5" stroke="#ffffff" strokeWidth="2" />
        </svg>
      );
    case 'stop':
      return (
        <svg className="legend__swatch" viewBox="0 0 24 16" aria-hidden="true">
          <circle cx="12" cy="8" r="4" fill="#ffffff" stroke="#334155" strokeWidth="1.5" />
        </svg>
      );
    case 'ride':
      return (
        <svg className="legend__swatch" viewBox="0 0 24 16" aria-hidden="true">
          <path d="M2 8h20" stroke="#ffffff" strokeWidth="7" strokeLinecap="round" />
          <path d="M2 8h20" stroke="#0b5fa5" strokeWidth="4" strokeLinecap="round" />
        </svg>
      );
    case 'walk':
      return (
        <svg className="legend__swatch" viewBox="0 0 24 16" aria-hidden="true">
          <path d="M2 8h20" stroke="#ffffff" strokeWidth="7" strokeLinecap="round" />
          <path d="M2 8h20" stroke="#64748b" strokeWidth="4" strokeDasharray="4 3.5" />
        </svg>
      );
    case 'origin':
    case 'destination': {
      const color = kind === 'origin' ? '#1d4ed8' : '#be123c';
      return (
        <svg className="legend__swatch" viewBox="0 0 24 16" aria-hidden="true">
          <circle cx="12" cy="8" r="7" fill={color} opacity="0.22" />
          <circle cx="12" cy="8" r="4" fill={color} stroke="#ffffff" strokeWidth="1.8" />
        </svg>
      );
    }
  }
}
