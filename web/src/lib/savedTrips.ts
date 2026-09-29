import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Itinerary, Place, RouteSummary, StopDetail } from './api.ts';
import { deleteBelow, getByIndex, OBSERVATIONS, putAll } from './idb.ts';
import {
  observationsFrom,
  routeDirection,
  summarise,
  watchKey,
  type Observation,
  type ReliabilitySummary,
  type Watch,
} from './reliability.ts';

/**
 * Trips a rider makes often, kept on this device.
 *
 * A saved trip is its two ends plus the boardings of the way it was saved —
 * "the 21 from Lake & Lyndale, then the Blue Line from Lake St" — which are
 * what the reliability history watches. The trip itself is always re-planned
 * fresh when opened, so a saved trip never goes stale when a timetable
 * changes; only the history is tied to the particular boardings.
 */
export interface SavedTrip {
  id: string;
  from: Place;
  to: Place;
  savedAt: number;
  boardings: Boarding[];
}

export interface Boarding extends Watch {
  stopName: string;
  route: Pick<RouteSummary, 'id' | 'shortName' | 'longName' | 'mode' | 'color' | 'textColor'>;
}

const STORAGE_KEY = 'livetrains.savedTrips';
const MAX_SAVED = 12;
/** History older than this says more about last season's timetable than today's. */
const HISTORY_DAYS = 120;

function readSaved(): SavedTrip[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(parsed) ? (parsed as SavedTrip[]).filter((t) => t && t.from && t.to && t.id) : [];
  } catch {
    return [];
  }
}

function writeSaved(trips: SavedTrip[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(trips));
  } catch {
    // Storage full or refused: the list lasts for this visit only.
  }
}

/** Whether two places are the same end of a trip, near enough. */
function samePlace(a: Place, b: Place): boolean {
  return Math.abs(a.lat - b.lat) < 0.0005 && Math.abs(a.lon - b.lon) < 0.0007;
}

export function boardingsOf(itinerary: Itinerary): Boarding[] {
  return itinerary.legs.flatMap((leg) =>
    leg.type === 'transit'
      ? [
          {
            stopId: leg.from.id,
            stopName: leg.from.name,
            routeId: leg.route.id,
            directionId: leg.directionId,
            route: {
              id: leg.route.id,
              shortName: leg.route.shortName,
              longName: leg.route.longName,
              mode: leg.route.mode,
              color: leg.route.color,
              textColor: leg.route.textColor,
            },
          },
        ]
      : [],
  );
}

export function useSavedTrips() {
  const [trips, setTrips] = useState<SavedTrip[]>(() => readSaved());

  // Another tab saving a trip should show up here too.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) setTrips(readSaved());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const update = useCallback((next: (current: SavedTrip[]) => SavedTrip[]) => {
    setTrips((current) => {
      const updated = next(current);
      writeSaved(updated);
      return updated;
    });
  }, []);

  const find = useCallback(
    (from: Place | null, to: Place | null) =>
      from && to ? trips.find((t) => samePlace(t.from, from) && samePlace(t.to, to)) : undefined,
    [trips],
  );

  const save = useCallback(
    (from: Place, to: Place, itinerary: Itinerary) => {
      update((current) => {
        const rest = current.filter((t) => !(samePlace(t.from, from) && samePlace(t.to, to)));
        const trip: SavedTrip = {
          id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
          from,
          to,
          savedAt: Math.floor(Date.now() / 1000),
          boardings: boardingsOf(itinerary),
        };
        return [trip, ...rest].slice(0, MAX_SAVED);
      });
    },
    [update],
  );

  const remove = useCallback((id: string) => update((current) => current.filter((t) => t.id !== id)), [update]);

  return { trips, find, save, remove };
}

/** How often to look at the watched stops while the app is open. */
const RECORD_EVERY_MS = 60_000;

/**
 * Writes down how the watched boardings actually run, while the app is open.
 *
 * Once a minute it reads the departures at each watched stop and records any
 * watched route that is about to leave. A departure is seen two or three
 * times on its way out; each look overwrites the last, so what is kept is the
 * prediction nearest the moment it left.
 */
export function useReliabilityRecorder(
  load: (stopId: string, limit?: number, signal?: AbortSignal) => Promise<StopDetail>,
  trips: SavedTrip[],
  enabled: boolean,
): number {
  const [version, setVersion] = useState(0);
  const watches = useMemo(() => {
    const byStop = new Map<string, Set<string>>();
    for (const trip of trips) {
      for (const boarding of trip.boardings) {
        const routes = byStop.get(boarding.stopId) ?? new Set<string>();
        routes.add(routeDirection(boarding.routeId, boarding.directionId));
        byStop.set(boarding.stopId, routes);
      }
    }
    return byStop;
  }, [trips]);

  useEffect(() => {
    if (!enabled || watches.size === 0) return;
    const controller = new AbortController();
    const record = async () => {
      // Nothing to learn from a hidden tab's throttled timers, and no reason
      // to spend a phone's battery on it.
      if (document.visibilityState === 'hidden') return;
      const now = Math.floor(Date.now() / 1000);
      const rows: Observation[] = [];
      for (const [stopId, routes] of watches) {
        try {
          const detail = await load(stopId, 20, controller.signal);
          rows.push(...observationsFrom(stopId, detail.departures, routes, now));
        } catch {
          // One stop failing to load costs one sample, not the recorder.
        }
      }
      if (controller.signal.aborted || rows.length === 0) return;
      await putAll(OBSERVATIONS, rows).catch(() => undefined);
      setVersion((v) => v + 1);
    };
    void record();
    const timer = window.setInterval(() => void record(), RECORD_EVERY_MS);
    // Old history is trimmed once per session rather than on every write.
    void deleteBelow(OBSERVATIONS, 'at', Math.floor(Date.now() / 1000) - HISTORY_DAYS * 86_400).catch(() => undefined);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [load, watches, enabled]);

  return version;
}

/** The summary for each watched boarding, refreshed when new rows land. */
export function useReliability(trips: SavedTrip[], version: number): Map<string, ReliabilitySummary> {
  const [summaries, setSummaries] = useState<Map<string, ReliabilitySummary>>(new Map());
  const keys = useMemo(
    () => [...new Set(trips.flatMap((t) => t.boardings.map((b) => watchKey(b))))].sort().join('\n'),
    [trips],
  );

  useEffect(() => {
    let cancelled = false;
    const list = keys ? keys.split('\n') : [];
    getByIndex<Observation>(OBSERVATIONS, 'key', list)
      .then((rows) => {
        if (cancelled) return;
        const grouped = new Map<string, Observation[]>();
        for (const row of rows) {
          const group = grouped.get(row.key) ?? [];
          group.push(row);
          grouped.set(row.key, group);
        }
        setSummaries(new Map(list.map((key) => [key, summarise(grouped.get(key) ?? [])])));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [keys, version]);

  return summaries;
}
