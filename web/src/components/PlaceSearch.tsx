import { useEffect, useId, useRef, useState } from 'react';
import { api, type Place } from '../lib/api.ts';

/**
 * A search box for picking an origin or destination.
 *
 * Results come from the server's index of stops and landmarks, so it works with
 * no geocoding key. Beyond typing, a place can also come from the device's
 * location or from tapping the map, which between them cover how people
 * actually choose a destination.
 */

interface Props {
  label: string;
  value: Place | null;
  placeholder: string;
  /** Bias results toward the map centre, so "3rd St" means the nearby one. */
  near?: { lat: number; lon: number };
  onChange: (place: Place | null) => void;
  onUseCurrentLocation?: () => void;
  onPickOnMap?: () => void;
  /** True while the parent is waiting for this field to be filled by a map tap. */
  awaitingMapPick?: boolean;
}

export function PlaceSearch({
  label,
  value,
  placeholder,
  near,
  onChange,
  onUseCurrentLocation,
  onPickOnMap,
  awaitingMapPick,
}: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Place[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);

  // Debounced search. The abort controller matters: without it a slow early
  // response can land after a later one and overwrite fresher results.
  useEffect(() => {
    if (!open) return;
    const text = query.trim();
    if (text.length < 2) {
      setResults([]);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    const timer = window.setTimeout(() => {
      api
        .geocode(text, near, controller.signal)
        .then((places) => {
          setResults(places);
          setHighlight(0);
        })
        .catch((err: unknown) => {
          if (!(err instanceof DOMException && err.name === 'AbortError')) setResults([]);
        })
        .finally(() => setLoading(false));
    }, 180);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
      setLoading(false);
    };
  }, [query, open, near?.lat, near?.lon]);

  // Close the dropdown when focus or a click goes elsewhere.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const choose = (place: Place) => {
    onChange(place);
    setQuery('');
    setResults([]);
    setOpen(false);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open || results.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlight((h) => Math.min(h + 1, results.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(results[highlight]);
    } else if (event.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div className="place-search" ref={rootRef}>
      <label className="place-search__label" htmlFor={`${listId}-input`}>
        {label}
      </label>

      {value && !open ? (
        <div className="place-search__chosen">
          <div className="place-search__chosen-text">
            <span className="place-search__chosen-name">{value.name}</span>
            {value.detail && <span className="place-search__chosen-detail">{value.detail}</span>}
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label={`Clear ${label}`}
            onClick={() => {
              onChange(null);
              setOpen(true);
            }}
          >
            ×
          </button>
        </div>
      ) : (
        <div className="place-search__field">
          <input
            id={`${listId}-input`}
            className="place-search__input"
            type="text"
            role="combobox"
            aria-expanded={open && results.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            autoComplete="off"
            placeholder={awaitingMapPick ? 'Tap the map to choose…' : placeholder}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={onKeyDown}
          />
          {loading && <span className="place-search__spinner" aria-hidden="true" />}
        </div>
      )}

      {open && (
        <div className="place-search__panel">
          <div className="place-search__actions">
            {onUseCurrentLocation && (
              <button type="button" className="chip" onClick={onUseCurrentLocation}>
                Use my location
              </button>
            )}
            {onPickOnMap && (
              <button
                type="button"
                className="chip"
                onClick={() => {
                  onPickOnMap();
                  setOpen(false);
                }}
              >
                Pick on map
              </button>
            )}
          </div>

          {results.length > 0 && (
            <ul className="place-search__results" id={listId} role="listbox">
              {results.map((place, index) => (
                <li key={place.id} role="option" aria-selected={index === highlight}>
                  <button
                    type="button"
                    className={`place-search__result${index === highlight ? ' is-active' : ''}`}
                    onMouseEnter={() => setHighlight(index)}
                    onClick={() => choose(place)}
                  >
                    <span className={`place-search__kind place-search__kind--${place.kind}`} aria-hidden="true" />
                    <span className="place-search__result-text">
                      <span className="place-search__result-name">{place.name}</span>
                      {place.detail && <span className="place-search__result-detail">{place.detail}</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {query.trim().length >= 2 && !loading && results.length === 0 && (
            <p className="place-search__empty">
              Nothing matched “{query.trim()}”. Try a stop name, a landmark, or tap the map.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
