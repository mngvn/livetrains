import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  type AgencyInfo,
  type FeedStatus,
  type Itinerary,
  type Place,
  type RouteSummary,
  type StopDetail,
  type StopSummary,
  type Vehicle,
} from './lib/api.ts';
import { VehicleTracker, type StreamStatus } from './lib/vehicleTracker.ts';
import { TransitMap } from './components/TransitMap.tsx';
import { PlaceSearch } from './components/PlaceSearch.tsx';
import { ItineraryDetail, ItinerarySummary } from './components/ItineraryView.tsx';
import { StopPanel } from './components/StopPanel.tsx';
import { VehiclePanel } from './components/VehiclePanel.tsx';
import { StatusBar } from './components/StatusBar.tsx';
import { RouteBadge } from './components/RouteBadge.tsx';
import { modeLabel } from './lib/format.ts';

type Tab = 'plan' | 'nearby' | 'routes';
/** Which field a map tap should fill, when the user chose "pick on map". */
type MapPickTarget = 'origin' | 'destination' | null;

export function App() {
  const [agency, setAgency] = useState<AgencyInfo | null>(null);
  const [status, setStatus] = useState<FeedStatus | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);

  const [tab, setTab] = useState<Tab>('plan');
  const [origin, setOrigin] = useState<Place | null>(null);
  const [destination, setDestination] = useState<Place | null>(null);
  const [mapPickTarget, setMapPickTarget] = useState<MapPickTarget>(null);

  const [itineraries, setItineraries] = useState<Itinerary[]>([]);
  const [selectedItinerary, setSelectedItinerary] = useState<number | null>(null);
  const [planMessage, setPlanMessage] = useState<string | null>(null);
  const [planning, setPlanning] = useState(false);

  const [stops, setStops] = useState<StopSummary[]>([]);
  const [nearbyStops, setNearbyStops] = useState<StopSummary[]>([]);
  const [routes, setRoutes] = useState<RouteSummary[]>([]);
  const [activeRoute, setActiveRoute] = useState<{ geometry: [number, number][]; color: string } | null>(null);
  const [activeRouteId, setActiveRouteId] = useState<string | null>(null);

  const [selectedStopId, setSelectedStopId] = useState<string | null>(null);
  const [selectedVehicleId, setSelectedVehicleId] = useState<string | null>(null);
  const [selectedVehicle, setSelectedVehicle] = useState<Vehicle | null>(null);

  const [viewport, setViewport] = useState<[number, number, number, number] | null>(null);
  const [stream, setStream] = useState<StreamStatus>({
    connected: false,
    vehicleCount: 0,
    lastUpdate: null,
    error: null,
  });
  /** Ticks once a second so every countdown on screen stays honest. */
  const [now, setNow] = useState(() => Date.now() / 1000);

  const tracker = useMemo(() => new VehicleTracker(), []);
  const sheetRef = useRef<HTMLDivElement>(null);

  // --- Boot -----------------------------------------------------------------
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([api.agency(controller.signal), api.status(controller.signal)])
      .then(([agencyInfo, feedStatus]) => {
        setAgency(agencyInfo);
        setStatus(feedStatus);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setBootError(
          err instanceof Error
            ? `${err.message}. Is the API server running?`
            : 'Could not reach the API server.',
        );
      });
    return () => controller.abort();
  }, []);

  // Poll feed health so the status bar reflects outages the stream cannot show.
  useEffect(() => {
    const timer = window.setInterval(() => {
      api.status().then(setStatus).catch(() => undefined);
    }, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now() / 1000), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  // --- Live vehicle stream --------------------------------------------------
  useEffect(() => {
    if (!agency?.hasVehicles) return;
    tracker.connect();
    const unsubscribe = tracker.onStatus(setStream);
    return () => {
      unsubscribe();
      tracker.disconnect();
    };
  }, [tracker, agency?.hasVehicles]);

  // Keep the selected vehicle's details fresh as new positions arrive.
  useEffect(() => {
    if (!selectedVehicleId) {
      setSelectedVehicle(null);
      return;
    }
    const update = () => setSelectedVehicle(tracker.get(selectedVehicleId) ?? null);
    update();
    const timer = window.setInterval(update, 2_000);
    return () => window.clearInterval(timer);
  }, [selectedVehicleId, tracker]);

  // --- Stops in view --------------------------------------------------------
  useEffect(() => {
    if (!viewport || !agency) return;
    const [west, south, east, north] = viewport;
    // Drawing every stop in a whole metro is unreadable and slow; only load
    // them once the viewport is tight enough for them to mean something.
    if (east - west > 0.35 || north - south > 0.3) {
      setStops([]);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      api
        .stopsWithin(viewport, 400, controller.signal)
        .then(setStops)
        .catch(() => undefined);
    }, 250);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [viewport, agency]);

  // --- Nearby tab -----------------------------------------------------------
  useEffect(() => {
    if (tab !== 'nearby' || !viewport) return;
    const [west, south, east, north] = viewport;
    const controller = new AbortController();
    api
      .nearbyStops((south + north) / 2, (west + east) / 2, 1200, 25, controller.signal)
      .then(setNearbyStops)
      .catch(() => undefined);
    return () => controller.abort();
  }, [tab, viewport]);

  // --- Routes tab -----------------------------------------------------------
  useEffect(() => {
    if (tab !== 'routes' || routes.length > 0) return;
    const controller = new AbortController();
    api.routes(controller.signal).then(setRoutes).catch(() => undefined);
    return () => controller.abort();
  }, [tab, routes.length]);

  // --- Planning -------------------------------------------------------------
  const runPlan = useCallback(
    (from: Place, to: Place) => {
      setPlanning(true);
      setPlanMessage(null);
      api
        .plan({ fromLat: from.lat, fromLon: from.lon, toLat: to.lat, toLon: to.lon })
        .then((result) => {
          setItineraries(result.itineraries);
          setSelectedItinerary(result.itineraries.length > 0 ? 0 : null);
          setPlanMessage(result.message ?? null);
        })
        .catch((err: unknown) => {
          setItineraries([]);
          setSelectedItinerary(null);
          setPlanMessage(err instanceof Error ? err.message : 'Could not plan that trip.');
        })
        .finally(() => setPlanning(false));
    },
    [],
  );

  // Plan automatically once both ends are known — the rider has already said
  // everything they need to; making them press a button as well is friction.
  useEffect(() => {
    if (origin && destination) {
      runPlan(origin, destination);
      setTab('plan');
      setSelectedStopId(null);
    } else {
      setItineraries([]);
      setSelectedItinerary(null);
      setPlanMessage(null);
    }
  }, [origin, destination, runPlan]);

  // --- Actions --------------------------------------------------------------
  const useCurrentLocation = useCallback((target: 'origin' | 'destination') => {
    if (!navigator.geolocation) {
      setPlanMessage('This browser cannot share your location.');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const place: Place = {
          id: 'current-location',
          name: 'My location',
          lat: position.coords.latitude,
          lon: position.coords.longitude,
          kind: 'current-location',
        };
        if (target === 'origin') setOrigin(place);
        else setDestination(place);
      },
      () => setPlanMessage('Could not get your location. Check location permissions.'),
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  }, []);

  const handleMapClick = useCallback(
    (lat: number, lon: number) => {
      if (!mapPickTarget) return;
      api
        .reverseGeocode(lat, lon)
        .then((place) => {
          if (mapPickTarget === 'origin') setOrigin(place);
          else setDestination(place);
        })
        .catch(() => {
          const fallback: Place = {
            id: `${lat},${lon}`,
            name: `${lat.toFixed(4)}, ${lon.toFixed(4)}`,
            lat,
            lon,
            kind: 'coordinate',
          };
          if (mapPickTarget === 'origin') setOrigin(fallback);
          else setDestination(fallback);
        })
        .finally(() => setMapPickTarget(null));
    },
    [mapPickTarget],
  );

  const showRoute = useCallback(
    (route: RouteSummary) => {
      if (activeRouteId === route.id) {
        setActiveRouteId(null);
        setActiveRoute(null);
        tracker.setFilter({});
        return;
      }
      setActiveRouteId(route.id);
      // Narrow the live stream to this route so the map shows only its vehicles.
      tracker.setFilter({ routeId: route.id });
      api
        .route(route.id)
        .then((detail) => {
          const direction = detail.directions[0];
          if (direction) setActiveRoute({ geometry: direction.geometry, color: detail.route.color });
        })
        .catch(() => undefined);
    },
    [activeRouteId, tracker],
  );

  const planFromStop = useCallback((detail: StopDetail, target: 'origin' | 'destination') => {
    const place: Place = {
      id: detail.stop.id,
      name: detail.stop.name,
      detail: `Stop ${detail.stop.code}`,
      lat: detail.stop.lat,
      lon: detail.stop.lon,
      kind: 'stop',
    };
    if (target === 'origin') setOrigin(place);
    else setDestination(place);
    setSelectedStopId(null);
  }, []);

  const mapCentre = useMemo(
    () =>
      viewport
        ? { lat: (viewport[1] + viewport[3]) / 2, lon: (viewport[0] + viewport[2]) / 2 }
        : agency
          ? { lat: agency.center[1], lon: agency.center[0] }
          : undefined,
    [viewport, agency],
  );

  if (bootError) {
    return (
      <div className="boot-error">
        <h1>livetrains</h1>
        <p>{bootError}</p>
        <p className="boot-error__hint">
          Start the API with <code>npm run dev</code>, or run it against the built-in demo feed with{' '}
          <code>LIVETRAINS_MOCK=1 npm run dev</code>.
        </p>
      </div>
    );
  }

  if (!agency) {
    return (
      <div className="boot-loading">
        <span className="spinner" />
        <p>Loading the transit feed…</p>
      </div>
    );
  }

  const chosen = selectedItinerary !== null ? (itineraries[selectedItinerary] ?? null) : null;

  return (
    <div className={`app${mapPickTarget ? ' is-picking' : ''}`}>
      <TransitMap
        agency={agency}
        tracker={tracker}
        stops={stops}
        itinerary={chosen}
        routeShape={activeRoute}
        selectedVehicleId={selectedVehicleId}
        origin={origin}
        destination={destination}
        onSelectVehicle={setSelectedVehicleId}
        onSelectStop={(stopId) => {
          setSelectedStopId(stopId);
          setSelectedVehicleId(null);
        }}
        onMapClick={handleMapClick}
        onViewportChange={setViewport}
      />

      {mapPickTarget && (
        <div className="map-pick-hint" role="status">
          Tap the map to set your {mapPickTarget === 'origin' ? 'starting point' : 'destination'}
          <button type="button" className="chip" onClick={() => setMapPickTarget(null)}>
            Cancel
          </button>
        </div>
      )}

      <div className="sheet" ref={sheetRef}>
        <header className="sheet__header">
          <h1 className="sheet__brand">
            livetrains
            <span className="sheet__agency">{agency.name}</span>
          </h1>
          <StatusBar status={status} stream={stream} />
        </header>

        {selectedVehicle ? (
          <VehiclePanel vehicle={selectedVehicle} onClose={() => setSelectedVehicleId(null)} />
        ) : selectedStopId ? (
          <StopPanel
            stopId={selectedStopId}
            now={now}
            onPlanFromHere={(detail) => planFromStop(detail, 'origin')}
            onPlanToHere={(detail) => planFromStop(detail, 'destination')}
            onClose={() => setSelectedStopId(null)}
          />
        ) : (
          <>
            <nav className="tabs" role="tablist">
              {(['plan', 'nearby', 'routes'] as Tab[]).map((id) => (
                <button
                  key={id}
                  role="tab"
                  aria-selected={tab === id}
                  className={`tab${tab === id ? ' is-active' : ''}`}
                  onClick={() => setTab(id)}
                >
                  {id === 'plan' ? 'Plan a trip' : id === 'nearby' ? 'Nearby' : 'Routes'}
                </button>
              ))}
            </nav>

            <div className="sheet__body">
              {tab === 'plan' && (
                <div className="plan-tab">
                  <PlaceSearch
                    label="From"
                    value={origin}
                    placeholder="Starting point"
                    near={mapCentre}
                    onChange={setOrigin}
                    onUseCurrentLocation={() => useCurrentLocation('origin')}
                    onPickOnMap={() => setMapPickTarget('origin')}
                    awaitingMapPick={mapPickTarget === 'origin'}
                  />
                  <PlaceSearch
                    label="To"
                    value={destination}
                    placeholder="Where are you going?"
                    near={mapCentre}
                    onChange={setDestination}
                    onUseCurrentLocation={() => useCurrentLocation('destination')}
                    onPickOnMap={() => setMapPickTarget('destination')}
                    awaitingMapPick={mapPickTarget === 'destination'}
                  />

                  {origin && destination && (
                    <button
                      type="button"
                      className="swap-button"
                      onClick={() => {
                        const previous = origin;
                        setOrigin(destination);
                        setDestination(previous);
                      }}
                    >
                      Swap start and destination
                    </button>
                  )}

                  {planning && <div className="panel-loading">Finding the best way there…</div>}

                  {!planning && planMessage && <p className="panel-empty">{planMessage}</p>}

                  {!planning && itineraries.length > 0 && (
                    <>
                      <ul className="itinerary-list">
                        {itineraries.map((itinerary, index) => (
                          <li key={`${itinerary.departureTime}-${index}`}>
                            <ItinerarySummary
                              itinerary={itinerary}
                              selected={selectedItinerary === index}
                              now={now}
                              onSelect={() => setSelectedItinerary(index)}
                            />
                          </li>
                        ))}
                      </ul>

                      {chosen && (
                        <ItineraryDetail
                          itinerary={chosen}
                          now={now}
                          onShowVehicle={setSelectedVehicleId}
                          onShowStop={setSelectedStopId}
                        />
                      )}
                    </>
                  )}

                  {!origin && !destination && !planning && (
                    <p className="panel-hint">
                      Pick a destination to see the fastest way there, with live vehicle positions
                      along the way. You can also tap any stop or vehicle on the map.
                    </p>
                  )}
                </div>
              )}

              {tab === 'nearby' && (
                <div className="nearby-tab">
                  <button type="button" className="chip" onClick={() => useCurrentLocation('origin')}>
                    Centre on my location
                  </button>
                  {nearbyStops.length === 0 ? (
                    <p className="panel-empty">No stops in view. Pan or zoom the map.</p>
                  ) : (
                    <ul className="stop-list">
                      {nearbyStops.map((stop) => (
                        <li key={stop.id}>
                          <button
                            type="button"
                            className="stop-list__item"
                            onClick={() => setSelectedStopId(stop.id)}
                          >
                            <span className="stop-list__text">
                              <span className="stop-list__name">{stop.name}</span>
                              <span className="stop-list__meta">
                                {stop.distance !== undefined && `${stop.distance} m away`}
                              </span>
                            </span>
                            <span className="stop-list__routes">
                              {(stop.routes ?? []).slice(0, 5).map((route) => (
                                <RouteBadge key={route.id} route={route} size="small" />
                              ))}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {tab === 'routes' && (
                <div className="routes-tab">
                  {activeRouteId && (
                    <button
                      type="button"
                      className="chip chip--primary"
                      onClick={() => {
                        setActiveRouteId(null);
                        setActiveRoute(null);
                        tracker.setFilter({});
                      }}
                    >
                      Show all routes again
                    </button>
                  )}
                  <ul className="route-list">
                    {routes.map((route) => (
                      <li key={route.id}>
                        <button
                          type="button"
                          className={`route-list__item${activeRouteId === route.id ? ' is-active' : ''}`}
                          onClick={() => showRoute(route)}
                        >
                          <RouteBadge route={route} />
                          <span className="route-list__text">
                            <span className="route-list__name">{route.longName || route.shortName}</span>
                            <span className="route-list__mode">{modeLabel(route.mode)}</span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
