import { useEffect, useId, useRef, useState } from 'react';
import type { RouteSummary, StopSummary, TransitSearchResult } from '../lib/api.ts';
import { modeLabel } from '../lib/format.ts';
import { RouteBadge } from './RouteBadge.tsx';

/**
 * Find a stop or a route by what is on the sign.
 *
 * Separate from the trip planner's place search on purpose: that one answers
 * "where am I going", this one "where is the 16" or "what calls at Nicollet
 * Mall". Riders think of routes by number and stops by name or the number on
 * the pole, and both are answered here without planning anything.
 */
export function TransitSearch({
  search,
  onRoute,
  onStop,
}: {
  /** Supplied by the app so this works against either backend. */
  search: (q: string, limit?: number, signal?: AbortSignal) => Promise<TransitSearchResult[]>;
  onRoute: (route: RouteSummary) => void;
  onStop: (stop: StopSummary) => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<TransitSearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const [searched, setSearched] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const text = query.trim();
    setSearched(false);
    if (!text) {
      setResults([]);
      return;
    }
    const controller = new AbortController();
    // Shorter than the place search's debounce: this is answered locally, and
    // route numbers are one or two keystrokes long.
    const timer = window.setTimeout(() => {
      search(text, 8, controller.signal)
        .then((found) => {
          setResults(found);
          setHighlight(0);
          setSearched(true);
        })
        .catch(() => undefined);
    }, 120);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query, search]);

  // Close when a click lands elsewhere.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  // "/" jumps to search from anywhere, as on most sites with one search box.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      event.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const choose = (result: TransitSearchResult) => {
    if (result.kind === 'route') onRoute(result.route);
    else onStop(result.stop);
    setQuery('');
    setResults([]);
    setOpen(false);
    inputRef.current?.blur();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      setOpen(false);
      return;
    }
    if (results.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
      setHighlight((h) => Math.min(h + 1, results.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(results[Math.min(highlight, results.length - 1)]);
    }
  };

  const showPanel = open && query.trim().length > 0 && (results.length > 0 || searched);

  return (
    <div className="transit-search" ref={rootRef}>
      <label className="visually-hidden" htmlFor={`${listId}-input`}>
        Search stops and routes
      </label>
      <svg className="transit-search__icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.7" />
        <path d="m10.5 10.5 3.3 3.3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      </svg>
      <input
        ref={inputRef}
        id={`${listId}-input`}
        className="transit-search__input"
        type="search"
        role="combobox"
        aria-expanded={showPanel && results.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showPanel && results.length > 0 ? `${listId}-${highlight}` : undefined}
        autoComplete="off"
        enterKeyHint="search"
        placeholder="Stop or route — e.g. 16, Blue, Nicollet Mall"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />

      {showPanel && (
        <div className="transit-search__panel">
          {results.length > 0 ? (
            <ul className="transit-search__results" id={listId} role="listbox" aria-label="Stops and routes">
              {results.map((result, index) => (
                <li
                  key={result.kind === 'route' ? `r:${result.route.id}` : `s:${result.stop.id}`}
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={index === highlight}
                >
                  <button
                    type="button"
                    tabIndex={-1}
                    className={`transit-search__result${index === highlight ? ' is-active' : ''}`}
                    onMouseEnter={() => setHighlight(index)}
                    onClick={() => choose(result)}
                  >
                    {result.kind === 'route' ? <RouteRow route={result.route} /> : <StopRow stop={result.stop} />}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="transit-search__empty" role="status">
              <p className="transit-search__empty-sign">No stops or routes match that</p>
              <p className="transit-search__empty-hint">Try a route number, a line colour, or part of a stop name.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RouteRow({ route }: { route: RouteSummary }) {
  return (
    <>
      <RouteBadge route={route} />
      <span className="transit-search__text">
        <span className="transit-search__name">{route.longName || route.shortName}</span>
        <span className="transit-search__detail">
          {modeLabel(route.mode)} route
          {route.operator && ` · ${route.operator.name}`}
        </span>
      </span>
    </>
  );
}

function StopRow({ stop }: { stop: StopSummary }) {
  const routes = stop.routes ?? [];
  return (
    <>
      <span className="transit-search__stop-icon" aria-hidden="true" />
      <span className="transit-search__text">
        <span className="transit-search__name">{stop.name}</span>
        <span className="transit-search__detail">
          {stop.code ? `Stop ${stop.code}` : 'Stop'}
          {stop.description && ` · ${stop.description}`}
        </span>
      </span>
      {routes.length > 0 && (
        <span className="transit-search__routes">
          {routes.slice(0, 4).map((route) => (
            <RouteBadge key={route.id} route={route} size="small" />
          ))}
          {routes.length > 4 && <span className="transit-search__more">+{routes.length - 4}</span>}
        </span>
      )}
    </>
  );
}
