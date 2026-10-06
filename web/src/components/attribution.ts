import type * as maplibregl from 'maplibre-gl';

/**
 * Keeps the map's credit line folded into its (i) once it has been seen.
 *
 * MapLibre's compact attribution opens itself whenever the control is created
 * or its credits change, and folds itself only when the map is dragged — so a
 * pinch-zoom never closed it, and this app, which rebuilds the control when the
 * aircraft credit changes, kept popping it open over the map a few seconds
 * after every load.
 *
 * The OpenStreetMap Foundation's attribution guidelines allow the credit to
 * collapse into an (i) after five seconds or on the first interaction with the
 * map, as long as it stays one tap away. That is the behaviour here: shown on
 * arrival, folded after five seconds or the first touch, scroll or click on the
 * map, and from then on opened and closed only by the rider tapping the (i).
 */

/** How long the credit stays open on arrival, per the OSMF guidelines. */
export const ATTRIBUTION_SHOW_MS = 5_000;

/** Whether the credit is open. Shared across rebuilds of the control. */
export interface AttributionState {
  open: boolean;
  /** Folded once, or tapped by the rider: no longer opened or folded automatically. */
  settled: boolean;
}

export interface QuietAttribution {
  /** Folds the credit, unless the rider has since opened it themselves. */
  fold(): void;
  /** Stops managing the control, before it is removed. */
  dispose(): void;
}

/**
 * Takes over the open/closed state of the attribution control on `map`.
 *
 * MapLibre keeps adjusting the control's classes on its own schedule; an
 * observer puts back whatever `state` says each time it does, and taps on the
 * (i) are answered here instead of by MapLibre, so nothing but this code and
 * the rider decides whether it is open.
 */
export function quietAttribution(map: maplibregl.Map, state: AttributionState): QuietAttribution {
  const container = map.getContainer().querySelector<HTMLElement>('.maplibregl-ctrl-attrib');
  if (!container) return { fold: () => undefined, dispose: () => undefined };

  const apply = () => {
    // Wide enough for the full line, MapLibre does not compact it: nothing to fold.
    if (!container.classList.contains('maplibregl-compact')) return;
    // It is a <details>; the content is shown or hidden by class, so it stays open.
    if (!container.hasAttribute('open')) container.setAttribute('open', '');
    container.classList.toggle('maplibregl-compact-show', state.open);
  };

  const observer = new MutationObserver(() => {
    const shown = container.classList.contains('maplibregl-compact-show');
    if (shown !== state.open || !container.hasAttribute('open')) apply();
  });
  observer.observe(container, { attributes: true, attributeFilter: ['class', 'open'] });

  const onClick = (event: Event) => {
    if (!(event.target instanceof Element) || !event.target.closest('.maplibregl-ctrl-attrib-button')) return;
    // The rider's tap is the only thing that opens it again: handled here, in
    // the capture phase, before the <details> or MapLibre can toggle anything.
    event.preventDefault();
    event.stopImmediatePropagation();
    state.settled = true;
    state.open = !state.open;
    apply();
  };
  container.addEventListener('click', onClick, true);

  apply();

  return {
    fold() {
      if (state.settled) return;
      state.settled = true;
      state.open = false;
      apply();
    },
    dispose() {
      observer.disconnect();
      container.removeEventListener('click', onClick, true);
    },
  };
}
