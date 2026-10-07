import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type AgencyInfo,
  type FeedStatus,
  type Itinerary,
  type Place,
  type RouteDetail,
  type RouteNetwork,
  type RouteSummary,
  type ServiceAlert,
  type StopDetail,
  type StopSummary,
  type Vehicle,
} from './lib/api.ts';
import { VehicleTracker, type StreamStatus } from './lib/vehicleTracker.ts';
import { createDataSource, type EngineStatus } from './lib/dataSource.ts';
import { LoadingScreen } from './components/LoadingScreen.tsx';
import { TransitMap, type CameraTarget, type MapPadding } from './components/TransitMap.tsx';
import { TransitSearch } from './components/TransitSearch.tsx';
import { PlaceSearch } from './components/PlaceSearch.tsx';
import { ItineraryDetail, ItinerarySummary } from './components/ItineraryView.tsx';
import { StopPanel } from './components/StopPanel.tsx';
import { VehiclePanel } from './components/VehiclePanel.tsx';
import { FEED_STALE_SECONDS, StatusBar } from './components/StatusBar.tsx';
import { RouteBadge } from './components/RouteBadge.tsx';
import { MapLegend } from './components/MapLegend.tsx';
import { usePersistedFlag } from './lib/persistedFlag.ts';
import { MapControls } from './components/MapControls.tsx';
import { JourneyPlayer } from './components/JourneyPlayer.tsx';
import { JourneyPlayback } from './lib/journeyPlayback.ts';
import { buildJourney } from './lib/journey.ts';
import { WalkRouter } from './lib/walkRouter.ts';
import { refineWalks } from './lib/refineWalks.ts';
import { useVehicleTrip } from './lib/useVehicleTrip.ts';
import { routeWideAlertCounts, useAlerts } from './lib/useAlerts.ts';
import { isActive } from './lib/alerts.ts';
import { alertedRouteIds, alertMarkers } from './lib/alertMap.ts';
import { RoutesTab } from './components/RoutesTab.tsx';
import { AlertsView } from './components/AlertsView.tsx';
import type { BasemapId } from './components/basemaps.ts';
import type { MapFocus } from './components/mapLayers.ts';
import { useTheme } from './lib/theme.ts';
import { hasSharedState, readSharedState, shareUrl, writeSharedState } from './lib/shareLink.ts';
import { ShareButton } from './components/ShareButton.tsx';
import { useReliability, useReliabilityRecorder, useSavedTrips, type SavedTrip } from './lib/savedTrips.ts';
import { useLeaveReminder } from './lib/leaveReminder.ts';
import { SavedTrips } from './components/SavedTrips.tsx';
import { LeaveBanner, LeaveNudge } from './components/LeaveNudge.tsx';
import { loadLastVehicles, saveLastVehicles, useOnline } from './lib/offline.ts';
import { Onboarding } from './components/Onboarding.tsx';
import { DetailPanel } from './components/DetailPanel.tsx';
import { NetworkStatus } from './components/NetworkStatus.tsx';
import { RideBanner, askToNotify } from './components/RideBanner.tsx';
import { rideProgress } from './lib/ride.ts';
import { isochroneGrid, type IsochroneGrid } from './lib/isochrone.ts';
import { ReachLegend } from './components/ReachLegend.tsx';
import { explainDelay } from './lib/lateness.ts';
import { networkHealth } from './lib/networkHealth.ts';
import { PlaneTracker, type PlaneFeedStatus } from './lib/planeTracker.ts';
import { planeFeedTemplate, planeFetcher } from './lib/planeFeed.ts';
import { PlanePanel } from './components/PlanePanel.tsx';
import { routeFits, usePlaneDetails } from './lib/planeLookup.ts';
import { greatCircle, whereBound } from './lib/planeBound.ts';
import type { Plane } from '@shared/planes.ts';

type Tab = 'plan' | 'nearby' | 'routes' | 'status' | 'alerts';

const TAB_LABELS: Record<Tab, string> = {
  plan: 'Plan',
  nearby: 'Nearby',
  routes: 'Routes',
  status: 'Status',
  alerts: 'Alerts',
};
/** Which field a map tap should fill, when the user chose "pick on map". */
type MapPickTarget = 'origin' | 'destination' | null;

/**
 * How long the welcome screen stays up at minimum.
 *
 * Matches the animation: the last of twenty-one letters starts at 900ms and
 * takes 620ms, and the underline finishes at 1,600ms.
 */
const WELCOME_MS = 1_800;

const BASEMAP_KEY = 'livetrains.basemap';



/** Set once the introduction has been seen or skipped. */
const ONBOARDED_KEY = 'livetrains.onboarded';

/**
 * The trip the introduction plays: the length of the Green Line, downtown
 * Minneapolis to downtown St Paul. One train, no transfer, a real walk at
 * each end — every part of the playback in one short watch.
 */
const SAMPLE_TRIP: { from: Place; to: Place; label: string } = {
  from: { id: 'sample-from', name: 'Target Field Station', lat: 44.9832, lon: -93.2777, kind: 'stop' },
  to: { id: 'sample-to', name: 'Union Depot', lat: 44.9479, lon: -93.0855, kind: 'stop' },
  label: 'Minneapolis to St Paul',
};

function shouldShowTour(): boolean {
  try {
    if (window.localStorage.getItem(ONBOARDED_KEY)) return false;
  } catch {
    return false;
  }
  // Someone arriving on a shared link came for that link, not a tour.
  return !hasSharedState(readSharedState(window.location.search));
}

/** The remembered basemap, tolerating storage being unavailable or stale. */
function readBasemap(): BasemapId {
  try {
    const stored = window.localStorage.getItem(BASEMAP_KEY);
    if (stored === 'streets' || stored === 'satellite') return stored;
  } catch {
    // Private browsing; fall through to the default.
  }
  return 'streets';
}

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
  /** Identifies the newest plan, so stale walk routing can be discarded. */
  const planRun = useRef(0);

  const [stops, setStops] = useState<StopSummary[]>([]);
  /** Stations, METRO stops and the busiest corners: drawn from metro scale. */
  const [majorStops, setMajorStops] = useState<StopSummary[]>([]);
  const [nearbyStops, setNearbyStops] = useState<StopSummary[]>([]);
  const [routes, setRoutes] = useState<RouteSummary[]>([]);
  const [activeRoute, setActiveRoute] = useState<{ geometry: [number, number][]; color: string } | null>(null);
  const [activeRouteId, setActiveRouteId] = useState<string | null>(null);
  /** The active route's full detail, for its alerts and operator. */
  const [activeRouteDetail, setActiveRouteDetail] = useState<RouteDetail | null>(null);
  /** Every route through the selected stop, lit up on the map. */
  const [highlightRouteIds, setHighlightRouteIds] = useState<string[] | null>(null);
  /** Every route's drawn shape, for the faint underlay beneath the vehicles. */
  const [network, setNetwork] = useState<RouteNetwork | null>(null);

  const [selectedStopId, setSelectedStopId] = useState<string | null>(null);
  const [selectedVehicleId, setSelectedVehicleId] = useState<string | null>(null);
  const [selectedVehicle, setSelectedVehicle] = useState<Vehicle | null>(null);
  const [selectedPlaneId, setSelectedPlaneId] = useState<string | null>(null);
  const [selectedPlane, setSelectedPlane] = useState<Plane | null>(null);

  const [viewport, setViewport] = useState<[number, number, number, number] | null>(null);
  /** Where the camera has been asked to go, by search or a shared link. */
  const [cameraTarget, setCameraTarget] = useState<CameraTarget | null>(null);
  const [stream, setStream] = useState<StreamStatus>({
    connected: false,
    vehicleCount: 0,
    lastUpdate: null,
    error: null,
  });
  /** Ticks once a second so every countdown on screen stays honest. */
  const [now, setNow] = useState(() => Date.now() / 1000);

  const tracker = useMemo(() => new VehicleTracker(), []);
  // One interface, two backends: the in-browser transit engine on a static
  // host, or the Node API server when one is configured.
  const source = useMemo(() => createDataSource(), []);
  const [engine, setEngine] = useState<EngineStatus>({ state: 'loading', progress: null, error: null });
  /**
   * Whether the side panel is collapsed out of the way.
   *
   * Remembered, because someone who wants the map uncovered usually wants it
   * uncovered every time, not once per visit.
   */
  const [panelHidden, togglePanel] = usePersistedFlag('livetrains.panelHidden');

  /**
   * Whether vehicles gather into counted groups at metro zoom.
   *
   * On by default: seven hundred markers at city scale are unreadable. Off
   * for anyone who would rather see every dot.
   */
  const [groupVehicles, toggleGroupVehicles] = usePersistedFlag('livetrains.group', true);

  /**
   * Aircraft overhead.
   *
   * On by default where there is a feed for them: they are drawn quietly
   * enough not to compete with the transit, and the legend turns them off for
   * anyone who would rather not. Off means off — the feed is not even asked.
   */
  const [planesOn, togglePlanes] = usePersistedFlag('livetrains.planes', true);
  const planeTracker = useMemo(() => new PlaneTracker(), []);
  const planeTemplate = useMemo(() => planeFeedTemplate(source.mode), [source]);
  const [planeStatus, setPlaneStatus] = useState<PlaneFeedStatus>({
    state: 'off',
    count: 0,
    airborne: 0,
    lastUpdate: null,
    error: null,
    source: null,
  });

  /**
   * How the map looks: which background, and whether it is tilted.
   *
   * Remembered for the same reason the other view preferences are — someone
   * who wants the satellite view wants it every time, not once per visit.
   */
  const [basemap, setBasemap] = useState<BasemapId>(() => readBasemap());
  const chooseBasemap = useCallback((id: BasemapId) => {
    setBasemap(id);
    try {
      window.localStorage.setItem(BASEMAP_KEY, id);
    } catch {
      // A preference that cannot be saved is not worth failing over.
    }
  }, []);
  const [three, toggleThree] = usePersistedFlag('livetrains.three');
  const theme = useTheme(agency ? { lat: agency.center[1], lon: agency.center[0] } : null);

  /**
   * The journey playback clock.
   *
   * One per session, reused as trips are chosen; it owns its own animation
   * frame loop, so it is created once and never recreated by a render.
   */
  const playback = useMemo(() => new JourneyPlayback(), []);

  /**
   * Real walking directions for the trips that get shown.
   *
   * One per session so its cache survives re-planning; transfers repeat
   * heavily, so after the first few trips most legs are answered locally.
   */
  const walkRouter = useMemo(() => new WalkRouter(), []);
  const [playingJourney, setPlayingJourney] = useState(false);
  useEffect(() => () => playback.dispose(), [playback]);

  const [showTour, setShowTour] = useState(shouldShowTour);
  /** Set by the tour's "Show me": play the sample as soon as it is planned. */
  const playWhenPlanned = useRef(false);
  const closeTour = useCallback(() => {
    setShowTour(false);
    try {
      window.localStorage.setItem(ONBOARDED_KEY, '1');
    } catch {
      // Seen again next visit; not worth failing over.
    }
  }, []);

  /**
   * Holds the welcome on screen long enough to finish playing.
   *
   * A first load takes many seconds and this costs nothing, but a returning
   * visitor has the timetable cached and would otherwise get a single frame of
   * half-risen letters, which looks like a glitch rather than a greeting.
   */
  const [welcomeDone, setWelcomeDone] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setWelcomeDone(true), WELCOME_MS);
    return () => window.clearTimeout(timer);
  }, []);

  /** The itinerary the rider is looking at, and the one playback animates. */
  const chosen = selectedItinerary !== null ? (itineraries[selectedItinerary] ?? null) : null;

  // A journey that is no longer on screen must not keep animating over the
  // map, so choosing a different trip — or clearing the plan — ends playback.
  useEffect(() => {
    if (!chosen) {
      playback.load(null);
      setPlayingJourney(false);
    }
  }, [chosen, playback]);

  /** Set when playback tucked the phone's bottom sheet away, to bring it back after. */
  const hidPanelForJourney = useRef(false);

  const startJourney = useCallback(() => {
    if (!chosen) return;
    const journey = buildJourney(chosen);
    if (!journey) return;
    playback.load(journey);
    setPlayingJourney(true);
    playback.play();
    // On a phone the sheet would cover most of the trip; tuck it away for
    // the length of the playback.
    if (!panelHidden && window.matchMedia('(max-width: 720px)').matches) {
      hidPanelForJourney.current = true;
      togglePanel();
    }
  }, [chosen, playback, panelHidden, togglePanel]);

  // The tour's sample trip, played the moment its plan is in.
  useEffect(() => {
    if (!playWhenPlanned.current || planning || !chosen) return;
    playWhenPlanned.current = false;
    startJourney();
  }, [planning, chosen, startJourney]);

  const endJourney = useCallback(() => {
    playback.load(null);
    setPlayingJourney(false);
    if (hidPanelForJourney.current) {
      hidPanelForJourney.current = false;
      if (panelHidden) togglePanel();
    }
  }, [playback, panelHidden, togglePanel]);

  const sheetRef = useRef<HTMLDivElement>(null);

  /**
   * How much of the map the panels cover, so the camera centres in what is
   * left. On a desktop the planner covers the left and the detail panel the
   * right. Below 1024px there is room for only one: the detail panel, when
   * open, has pushed the planner away. On a phone whichever is showing is a
   * bottom sheet, measured because its height follows its content.
   */
  const [mapPadding, setMapPadding] = useState<MapPadding>({ top: 0, right: 0, bottom: 0, left: 0 });
  const shellReady = engine.state === 'ready' && agency !== null && welcomeDone;
  const detailOpen = selectedStopId !== null || selectedVehicleId !== null || selectedPlaneId !== null;
  useEffect(() => {
    const sheet = sheetRef.current;
    if (!shellReady || !sheet) return;
    const phone = window.matchMedia('(max-width: 720px)');
    const narrow = window.matchMedia('(max-width: 1023px)');
    const detail = document.querySelector<HTMLElement>('.detail');
    const measure = () => {
      const next: MapPadding = { top: 0, right: 0, bottom: 0, left: 0 };
      const detailRect = detailOpen && detail ? detail.getBoundingClientRect() : null;
      const sheetRect = sheet.getBoundingClientRect();
      if (phone.matches) {
        if (detailRect) next.bottom = Math.round(window.innerHeight - detailRect.top);
        else if (!panelHidden) next.bottom = Math.round(window.innerHeight - sheetRect.top);
      } else {
        if (detailRect) next.right = Math.round(window.innerWidth - detailRect.left);
        if (!panelHidden && !(detailRect && narrow.matches)) next.left = Math.round(sheetRect.right);
      }
      next.bottom = Math.max(0, next.bottom);
      next.left = Math.max(0, next.left);
      next.right = Math.max(0, next.right);
      setMapPadding((current) =>
        Math.abs(current.bottom - next.bottom) < 8 &&
        Math.abs(current.left - next.left) < 8 &&
        Math.abs(current.right - next.right) < 8
          ? current
          : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(sheet);
    if (detail) observer.observe(detail);
    window.addEventListener('resize', measure);
    phone.addEventListener('change', measure);
    narrow.addEventListener('change', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
      phone.removeEventListener('change', measure);
      narrow.removeEventListener('change', measure);
    };
  }, [shellReady, panelHidden, detailOpen]);

  // --- Boot -----------------------------------------------------------------
  useEffect(() => {
    const unsubscribe = source.onStatus(setEngine);
    source.start();
    return () => {
      unsubscribe();
      source.dispose();
    };
  }, [source]);

  useEffect(() => {
    if (engine.state !== 'ready') return;
    const controller = new AbortController();
    Promise.all([source.agency(controller.signal), source.status(controller.signal)])
      .then(([agencyInfo, feedStatus]) => {
        setAgency(agencyInfo);
        setStatus(feedStatus);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setBootError(
          err instanceof Error
            ? source.mode === 'server'
              ? `${err.message}. Is the API server running?`
              : err.message
            : 'Could not load the transit feed.',
        );
      });
    return () => controller.abort();
  }, [source, engine.state]);

  // Poll feed health so the status bar reflects outages the stream cannot show.
  useEffect(() => {
    if (engine.state !== 'ready') return;
    const timer = window.setInterval(() => {
      source.status().then(setStatus).catch(() => undefined);
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [source, engine.state]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now() / 1000), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  // --- Live vehicle stream --------------------------------------------------
  useEffect(() => {
    if (!agency?.hasVehicles) return;
    tracker.connect({}, source);
    const unsubscribe = tracker.onStatus(setStream);
    return () => {
      unsubscribe();
      tracker.disconnect();
    };
  }, [tracker, source, agency?.hasVehicles]);

  // --- Offline: last-known vehicles ----------------------------------------
  const online = useOnline();
  /** When the positions on the map were last live, once they are not. */
  const [lastKnownAt, setLastKnownAt] = useState<number | null>(null);

  // Put the last positions seen on the map straight away. On a good
  // connection live ones replace them within seconds; offline, they are all
  // there is, drawn faded and dated.
  useEffect(() => {
    if (!agency?.hasVehicles) return;
    let cancelled = false;
    void loadLastVehicles().then((saved) => {
      if (cancelled || !saved) return;
      tracker.restore(saved.vehicles);
      setLastKnownAt((current) => current ?? saved.asOf);
    });
    return () => {
      cancelled = true;
    };
  }, [tracker, agency?.hasVehicles]);

  // Keep a copy of the live fleet, every half minute while it is live.
  const lastLive = useRef<number | null>(null);
  if (stream.connected && stream.lastUpdate !== null) lastLive.current = stream.lastUpdate;
  useEffect(() => {
    if (!stream.connected) {
      // Losing the feed dates what is left on the map.
      if (lastLive.current !== null) setLastKnownAt(lastLive.current);
      return;
    }
    setLastKnownAt(null);
    const save = () => {
      const vehicles = tracker.snapshot();
      if (vehicles.length > 0 && lastLive.current !== null) void saveLastVehicles(vehicles, lastLive.current);
    };
    const first = window.setTimeout(save, 5_000);
    const timer = window.setInterval(save, 30_000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [tracker, stream.connected]);

  // --- Aircraft overhead -----------------------------------------------------
  useEffect(() => planeTracker.onStatus(setPlaneStatus), [planeTracker]);
  const agencyBbox = agency?.bbox;
  const bboxKey = agencyBbox?.join(',');
  useEffect(() => {
    if (!planesOn || !planeTemplate || !agencyBbox || engine.state !== 'ready') return;
    planeTracker.start(planeFetcher(planeTemplate, agencyBbox));
    return () => planeTracker.stop();
    // The box by value: a new agency object with the same box is the same sky.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planeTracker, planesOn, planeTemplate, bboxKey, engine.state]);

  // The chosen plane, refreshed as it moves; it closes if planes are turned off.
  useEffect(() => {
    if (!selectedPlaneId) {
      setSelectedPlane(null);
      return;
    }
    if (!planesOn) {
      setSelectedPlaneId(null);
      return;
    }
    const update = () => setSelectedPlane(planeTracker.get(selectedPlaneId) ?? null);
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [selectedPlaneId, planeTracker, planesOn]);

  // Where the chosen plane is going: its published route if it is really on
  // it, else a landing or a heading. Shared by the panel and the map.
  const planeDetails = usePlaneDetails(selectedPlane);
  const planeRoute =
    selectedPlane && planeDetails && planeDetails !== 'loading' && planeDetails.route && routeFits(planeDetails.route, selectedPlane)
      ? planeDetails.route
      : null;
  const planeBound = useMemo(() => (selectedPlane ? whereBound(selectedPlane, planeRoute) : null), [selectedPlane, planeRoute]);

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
    if (!viewport || !agency || engine.state !== 'ready') return;
    const [west, south, east, north] = viewport;
    // Ordinary stops only appear once you are looking at a street, so they
    // are only loaded then. Stations and busy stops are drawn network-wide
    // from their own list.
    if (east - west > 0.14 || north - south > 0.1) {
      setStops([]);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      source
        .stopsWithin(viewport, 400, controller.signal)
        .then(setStops)
        .catch(() => undefined);
    }, 250);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [viewport, agency, engine.state, source]);

  // --- Nearby tab -----------------------------------------------------------
  useEffect(() => {
    if (tab !== 'nearby' || !viewport || engine.state !== 'ready') return;
    const [west, south, east, north] = viewport;
    const controller = new AbortController();
    source
      .nearbyStops((south + north) / 2, (west + east) / 2, 1200, 25, controller.signal)
      .then(setNearbyStops)
      .catch(() => undefined);
    return () => controller.abort();
  }, [tab, viewport, engine.state, source]);

  // --- Routes tab -----------------------------------------------------------
  useEffect(() => {
    // Loaded for the legend as well as the Routes tab, so this is no longer
    // gated on the tab being open.
    if (routes.length > 0 || engine.state !== 'ready') return;
    const controller = new AbortController();
    source.routes(controller.signal).then(setRoutes).catch(() => undefined);
    return () => controller.abort();
  }, [routes.length, engine.state, source]);

  // --- Major stops, once ------------------------------------------------------
  useEffect(() => {
    if (majorStops.length > 0 || engine.state !== 'ready') return;
    const controller = new AbortController();
    source.majorStops(controller.signal).then(setMajorStops).catch(() => undefined);
    return () => controller.abort();
  }, [majorStops.length, engine.state, source]);

  // --- The route network underlay -------------------------------------------
  useEffect(() => {
    if (network || engine.state !== 'ready') return;
    const controller = new AbortController();
    // Built from every route's geometry, so it is the one heavy query here;
    // a failure costs the underlay and nothing else.
    source
      .routeNetwork(controller.signal)
      .then(setNetwork)
      .catch(() => undefined);
    return () => controller.abort();
  }, [network, engine.state, source]);

  // --- Planning -------------------------------------------------------------
  const runPlan = useCallback(
    (from: Place, to: Place) => {
      setPlanning(true);
      setPlanMessage(null);
      // Each plan cancels the previous one's walk routing, so a fast typist
      // does not get the paths from a trip they have already moved on from.
      planRun.current += 1;
      const run = planRun.current;

      source
        .plan({ fromLat: from.lat, fromLon: from.lon, toLat: to.lat, toLon: to.lon })
        .then((result) => {
          // Show the plan immediately with its estimated walks. Real walking
          // directions are a network round trip per leg, and making the whole
          // trip wait on them would trade a visible answer for a spinner.
          setItineraries(result.itineraries);
          setSelectedItinerary(result.itineraries.length > 0 ? 0 : null);
          setPlanMessage(result.message ?? null);

          void Promise.all(
            result.itineraries.map((itinerary) => refineWalks(itinerary, walkRouter)),
          ).then((refined) => {
            // A later plan has already replaced this one; its walks are not
            // wanted and would overwrite the newer result.
            if (run !== planRun.current) return;
            // Identity is the signal that nothing was routed, so an unreachable
            // router costs no render.
            if (refined.every((itinerary, i) => itinerary === result.itineraries[i])) return;
            setItineraries(refined);
          });
        })
        .catch((err: unknown) => {
          setItineraries([]);
          setSelectedItinerary(null);
          setPlanMessage(err instanceof Error ? err.message : 'Could not plan that trip.');
        })
        .finally(() => setPlanning(false));
    },
    [source, walkRouter],
  );

  // Plan automatically once both ends are known — the rider has already said
  // everything they need to; making them press a button as well is friction.
  useEffect(() => {
    if (origin && destination) {
      runPlan(origin, destination);
      setTab('plan');
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

  const closeDetail = useCallback(() => {
    setSelectedStopId(null);
    setSelectedVehicleId(null);
    setSelectedPlaneId(null);
  }, []);

  const handleMapClick = useCallback(
    (lat: number, lon: number) => {
      // A tap on empty map is a click away from whatever the panel shows.
      if (!mapPickTarget) {
        closeDetail();
        return;
      }
      source
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
    [mapPickTarget, closeDetail, source],
  );

  const clearRoute = useCallback(() => {
    setActiveRouteId(null);
    setActiveRoute(null);
    setActiveRouteDetail(null);
  }, []);

  const showRoute = useCallback(
    (route: RouteSummary) => {
      if (activeRouteId === route.id) {
        clearRoute();
        return;
      }
      setActiveRouteId(route.id);
      setActiveRouteDetail(null);
      // Every other vehicle stays on the map, dimmed: the route reads against
      // the rest of the network rather than floating on an empty one.
      source
        .route(route.id)
        .then((detail) => {
          setActiveRouteDetail(detail);
          const direction = detail.directions[0];
          if (direction) setActiveRoute({ geometry: direction.geometry, color: detail.route.color });
        })
        .catch(() => undefined);
    },
    [activeRouteId, source, clearRoute],
  );

  /** Routes by id, for drawing badges wherever only an id is at hand. */
  const routesById = useMemo(() => new Map(routes.map((route) => [route.id, route])), [routes]);

  // --- The detail panel -----------------------------------------------------
  // One stop or one vehicle at a time; choosing either replaces whatever the
  // panel was showing, in place.
  const showStop = useCallback((stopId: string) => {
    setSelectedVehicleId(null);
    setSelectedPlaneId(null);
    setSelectedStopId(stopId);
  }, []);

  /** Pinned under the selected stop; set once the stop's record has loaded. */
  const [stopPin, setStopPin] = useState<{ id: string; name: string; lat: number; lon: number } | null>(null);

  /**
   * Opens a route from anywhere — a stop's lines, an alert, a vehicle.
   *
   * Unlike tapping it in the route list, this never toggles it off: arriving
   * at a route from somewhere else should always show it.
   */
  const openRoute = useCallback(
    (routeId: string) => {
      const route = routesById.get(routeId);
      if (!route) return;
      // Where only one panel fits, the route list is what was asked for.
      if (window.matchMedia('(max-width: 1023px)').matches) closeDetail();
      setTab('routes');
      if (activeRouteId !== routeId) showRoute(route);
    },
    [routesById, activeRouteId, showRoute, closeDetail],
  );

  const showVehicle = useCallback((vehicleId: string) => {
    setSelectedStopId(null);
    setSelectedPlaneId(null);
    setSelectedVehicleId(vehicleId);
  }, []);

  const showPlane = useCallback((planeId: string) => {
    setSelectedStopId(null);
    setSelectedVehicleId(null);
    setSelectedPlaneId(planeId);
  }, []);

  const { trip: vehicleTrip, loading: vehicleTripLoading } = useVehicleTrip(source.vehicleTrip, selectedVehicleId);

  // --- Why the selected vehicle is late ---------------------------------------
  const explanationTick = Math.floor(now / 5);
  const lateness = useMemo(
    () =>
      selectedVehicle
        ? explainDelay({
            vehicle: selectedVehicle,
            trip: vehicleTrip && vehicleTrip.vehicleId === selectedVehicle.id ? vehicleTrip : null,
            others: tracker.snapshot(),
            history: tracker.delayHistory(selectedVehicle.id),
            now: Date.now() / 1000,
          })
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedVehicle, vehicleTrip, tracker, explanationTick],
  );

  // --- How far you can get ------------------------------------------------------
  /** The shaded map of everywhere reachable from a stop, while it is shown. */
  const [reach, setReach] = useState<{ stopId: string; stopName: string; departAt: number; grid: IsochroneGrid } | null>(
    null,
  );
  /** The stop whose reach is being worked out, while the search runs. */
  const [reachLoading, setReachLoading] = useState<string | null>(null);
  const toggleReach = useCallback(
    (stopId: string) => {
      if (reach?.stopId === stopId) {
        setReach(null);
        return;
      }
      setReachLoading(stopId);
      source
        .reachable(stopId, 30)
        .then((result) => {
          const grid = isochroneGrid(result);
          setReach({ stopId, stopName: result.origin.name, departAt: result.departAt, grid });
          if (grid.bounds) setCameraTarget({ bounds: grid.bounds });
        })
        .catch(() => undefined)
        .finally(() => setReachLoading((current) => (current === stopId ? null : current)));
    },
    [reach?.stopId, source],
  );

  // --- Riding along -----------------------------------------------------------
  /** The vehicle you are on, and the stop you are getting off at once chosen. */
  const [ride, setRide] = useState<{ vehicleId: string; stopId: string | null } | null>(null);
  const { trip: rideTrip } = useVehicleTrip(source.vehicleTrip, ride?.vehicleId ?? null);
  const progress = useMemo(
    () =>
      ride && rideTrip && rideTrip.vehicleId === ride.vehicleId
        ? rideProgress(rideTrip, ride.stopId, tracker.get(ride.vehicleId) ?? null, now)
        : null,
    [ride, rideTrip, tracker, now],
  );
  const startRide = useCallback((vehicleId: string, stopId: string | null) => {
    setRide({ vehicleId, stopId });
    // Asked now, while there is a tap to ask on and an obvious reason.
    if (stopId) void askToNotify();
  }, []);
  // Once you are off, the ride winds itself up after a couple of minutes.
  const arrived = progress?.phase === 'arrived';
  useEffect(() => {
    if (!arrived) return;
    const timer = window.setTimeout(() => setRide(null), 120_000);
    return () => window.clearTimeout(timer);
  }, [arrived]);

  const { alerts, places: alertPlacesList } = useAlerts(source.alerts, engine.state === 'ready');
  /** What the alerts view is showing after its filters, mirrored on the map. */
  const [shownAlerts, setShownAlerts] = useState<ServiceAlert[]>([]);
  // The view rebuilds its list on every one-second tick. Keep the same array
  // while it holds the same alerts, or the map's markers below would be
  // rebuilt, and the clusters redrawn, every second as well.
  const showAlerts = useCallback((shown: ServiceAlert[]) => {
    setShownAlerts((prev) =>
      prev.length === shown.length && prev.every((alert, i) => alert === shown[i]) ? prev : shown,
    );
  }, []);
  // Alerts start and end on the minute at the finest; redrawing the map's
  // markers on every one-second tick would only make the clusters churn.
  const alertMinute = Math.floor(now / 60) * 60;
  const alertMapMarkers = useMemo(
    () => (tab === 'alerts' ? alertMarkers(shownAlerts, alertPlacesList, alertMinute) : null),
    [tab, shownAlerts, alertPlacesList, alertMinute],
  );
  const alertCounts = useMemo(() => routeWideAlertCounts(alerts), [alerts]);
  const activeAlertCount = useMemo(() => alerts.filter((alert) => isActive(alert, now)).length, [alerts, now]);

  // The network's health, worked out only while someone is looking at it,
  // and refreshed every few seconds rather than every tick of the clock.
  const healthTick = Math.floor(now / 5);
  const health = useMemo(
    () => (tab === 'status' ? networkHealth(routes, tracker.snapshot(), alerts, Date.now() / 1000) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tab, routes, alerts, tracker, healthTick],
  );

  // --- Saved trips, their history, and when to leave ------------------------
  const saved = useSavedTrips();
  const reliabilityVersion = useReliabilityRecorder(source.stop, saved.trips, engine.state === 'ready');
  const reliability = useReliability(saved.trips, reliabilityVersion);
  const savedCurrent = saved.find(origin, destination);
  const leave = useLeaveReminder(chosen, source.stop, now);

  const openSavedTrip = useCallback(
    (trip: SavedTrip) => {
      // "From where I am" is re-read every time, not frozen where it was saved.
      if (trip.from.kind === 'current-location') useCurrentLocation('origin');
      else setOrigin(trip.from);
      setDestination(trip.to);
      setTab('plan');
    },
    [useCurrentLocation],
  );

  // Say it in the tab title too: a reminder is most useful when the rider is
  // looking at some other tab.
  useEffect(() => {
    if (!leave.fired) return;
    const previous = document.title;
    document.title = '⏰ Time to leave · livetrains';
    return () => {
      document.title = previous;
    };
  }, [leave.fired]);

  // --- Shared links ---------------------------------------------------------
  /** What the page was opened with, read once. */
  const shared = useMemo(() => readSharedState(window.location.search), []);
  /** Until a link has been applied, the URL is left alone rather than wiped. */
  const sharedApplied = useRef(!hasSharedState(shared));

  useEffect(() => {
    if (sharedApplied.current || engine.state !== 'ready' || !agency) return;
    // A route can only be opened once the route list is in.
    if (shared.route && routes.length === 0) return;
    sharedApplied.current = true;
    if (shared.from) setOrigin(shared.from);
    if (shared.to) setDestination(shared.to);
    if (shared.from || shared.to) setTab('plan');
    if (shared.route) openRoute(shared.route);
    if (shared.stop && !(shared.from && shared.to)) {
      const stopId = shared.stop;
      showStop(stopId);
      source
        .stop(stopId, 1)
        .then((detail) => setCameraTarget({ lon: detail.stop.lon, lat: detail.stop.lat, zoom: 16 }))
        .catch(() => undefined);
    }
  }, [shared, engine.state, agency, routes.length, openRoute, source, showStop]);

  // Keep the address bar describing what is on screen, so copying it from
  // the browser shares exactly this view. Replaced, not pushed: every stop
  // tapped should not become a step in the back button's history.
  useEffect(() => {
    if (!sharedApplied.current) return;
    const query = writeSharedState(
      {
        from: origin ?? undefined,
        to: destination ?? undefined,
        stop: selectedStopId ?? undefined,
        route: activeRouteId ?? undefined,
      },
      window.location.search,
    );
    const next = `${window.location.pathname}${query}${window.location.hash}`;
    if (next !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
      window.history.replaceState(window.history.state, '', next);
    }
  }, [origin, destination, selectedStopId, activeRouteId]);

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

  /**
   * The routes the map is about right now, most specific first: the selected
   * vehicle's, else every line through the selected stop, else the route
   * being browsed. Everything else on the map steps back.
   */
  const mapFocus = useMemo<MapFocus | null>(() => {
    if (selectedVehicleId) {
      return selectedVehicle?.routeId ? { kind: 'vehicle', routeIds: [selectedVehicle.routeId] } : null;
    }
    if (selectedStopId) {
      return highlightRouteIds && highlightRouteIds.length > 0 ? { kind: 'stop', routeIds: highlightRouteIds } : null;
    }
    if (activeRouteId) return { kind: 'route', routeIds: [activeRouteId] };
    // The status board: the map shows where the trouble is.
    if (tab === 'status' && health) {
      const trouble = health.lines.filter((line) => line.state !== 'good' && line.state !== 'quiet');
      if (trouble.length > 0) return { kind: 'network', routeIds: trouble.map((line) => line.route.id) };
    }
    // The alerts view: lines with a detour or the like come forward.
    if (tab === 'alerts') {
      const alerted = alertedRouteIds(shownAlerts, alertMinute);
      if (alerted.length > 0) return { kind: 'network', routeIds: alerted };
    }
    const tripRoutes = chosen
      ? [...new Set(chosen.legs.flatMap((leg) => (leg.type === 'transit' ? [leg.route.id] : [])))]
      : [];
    return tripRoutes.length > 0 ? { kind: 'trip', routeIds: tripRoutes } : null;
  }, [selectedVehicleId, selectedVehicle?.routeId, selectedStopId, highlightRouteIds, activeRouteId, chosen, tab, health, shownAlerts, alertMinute]);

  /** The live feed has said nothing new for long enough that nothing on the map is live. */
  const feedStale = stream.lastUpdate !== null && now - stream.lastUpdate > FEED_STALE_SECONDS;

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

  // Browser mode has a real first-load cost — a 19MB timetable to fetch and
  // parse — so show what is actually happening rather than a bare spinner.
  if (engine.state !== 'ready' || !agency || !welcomeDone) {
    return (
      <LoadingScreen
        status={engine}
        mode={source.mode}
        onRetry={() => source.refresh(true)}
      />
    );
  }


  return (
    <div
      className={`app${mapPickTarget ? ' is-picking' : ''}${detailOpen ? ' has-detail' : ''}${ride ? ' is-riding' : ''}`}
    >
      <TransitMap
        agency={agency}
        tracker={tracker}
        stops={stops}
        majorStops={majorStops}
        itinerary={chosen}
        routeShape={activeRoute}
        network={network}
        selectedVehicleId={selectedVehicleId}
        origin={origin}
        destination={destination}
        onSelectVehicle={showVehicle}
        onSelectStop={showStop}
        onMapClick={handleMapClick}
        onViewportChange={setViewport}
        groupVehicles={groupVehicles}
        basemap={basemap}
        dark={theme.resolved === 'dark'}
        three={three}
        playback={playback}
        focusJourney={playingJourney}
        focus={mapFocus}
        vehicleTrip={selectedVehicleId ? vehicleTrip : null}
        vehiclePosition={selectedVehicle ? [selectedVehicle.lon, selectedVehicle.lat] : null}
        cameraTarget={cameraTarget}
        padding={mapPadding}
        pin={selectedStopId && stopPin ? stopPin : null}
        feedStale={feedStale}
        followVehicleId={ride?.vehicleId ?? null}
        isochrone={reach?.grid.cells ?? null}
        planeTracker={planeTracker}
        selectedPlaneId={selectedPlaneId}
        onSelectPlane={showPlane}
        planeAttribution={planesOn ? planeCredit(planeStatus.source) : null}
        planeBound={
          planeBound
            ? {
                kind: planeBound.kind,
                // An airport by its code; a city it is only heading towards, by name.
                label: planeBound.kind === 'toward' ? planeBound.place.name : planeBound.place.code,
                lat: planeBound.place.lat,
                lon: planeBound.place.lon,
              }
            : null
        }
        alerts={alertMapMarkers}
        creditHeld={showTour}
      />

      {reach && (
        <ReachLegend stopName={reach.stopName} departAt={reach.departAt} onClose={() => setReach(null)} />
      )}

      {ride && progress && (
        <RideBanner
          route={rideTrip?.route ?? null}
          progress={progress}
          onEnd={() => setRide(null)}
          onShowVehicle={() => showVehicle(ride.vehicleId)}
        />
      )}

      <LeaveBanner
        state={leave}
        onShowTrip={() => {
          leave.dismiss();
          setSelectedStopId(null);
          setSelectedVehicleId(null);
          setTab('plan');
          if (panelHidden) togglePanel();
        }}
      />

      {playingJourney && (
        <JourneyPlayer playback={playback} onClose={endJourney} panelHidden={panelHidden} />
      )}

      <MapControls
        basemap={basemap}
        onBasemap={chooseBasemap}
        three={three}
        onThree={(next) => {
          if (next !== three) toggleThree();
        }}
        theme={theme.choice}
        onTheme={theme.setChoice}
      />

      {showTour && (
        <Onboarding
          onClose={closeTour}
          sampleLabel={SAMPLE_TRIP.label}
          onPlaySample={
            // Only where the sample trip is actually in this agency's area.
            [SAMPLE_TRIP.from, SAMPLE_TRIP.to].every(
              (p) => p.lon >= agency.bbox[0] && p.lon <= agency.bbox[2] && p.lat >= agency.bbox[1] && p.lat <= agency.bbox[3],
            )
              ? () => {
                  closeTour();
                  setSelectedStopId(null);
                  setSelectedVehicleId(null);
                  setTab('plan');
                  if (panelHidden) togglePanel();
                  playWhenPlanned.current = true;
                  setOrigin(SAMPLE_TRIP.from);
                  setDestination(SAMPLE_TRIP.to);
                }
              : undefined
          }
        />
      )}

      <MapLegend
        onReplayTour={() => setShowTour(true)}
        routes={routes}
        grouped={groupVehicles}
        onToggleGrouped={toggleGroupVehicles}
        planes={planeTemplate ? { on: planesOn, status: planeStatus, onToggle: togglePlanes } : null}
      />

      {panelHidden && (
        <button
          type="button"
          className="panel-reveal"
          onClick={togglePanel}
          aria-expanded={false}
          aria-controls="livetrains-panel"
        >
          <span aria-hidden="true">☰</span>
          Plan a trip
        </button>
      )}

      {mapPickTarget && (
        <div className="map-pick-hint" role="status">
          Tap the map to set your {mapPickTarget === 'origin' ? 'starting point' : 'destination'}
          <button type="button" className="chip" onClick={() => setMapPickTarget(null)}>
            Cancel
          </button>
        </div>
      )}

      <div
        className={`sheet${panelHidden ? ' is-hidden' : ''}`}
        id="livetrains-panel"
        ref={sheetRef}
        // Keep the collapsed panel out of the tab order and off screen readers;
        // the reveal button is the way back in.
        aria-hidden={panelHidden}
        inert={panelHidden}
      >
        <header className="sheet__header">
          <div className="sheet__title-row">
            <h1 className="sheet__brand">
              livetrains
              <span className="sheet__agency">{agency.name}</span>
            </h1>
            <button
              type="button"
              className="icon-button sheet__collapse"
              onClick={togglePanel}
              aria-expanded={!panelHidden}
              aria-controls="livetrains-panel"
              title="Close this panel"
            >
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                <path
                  d="M4 4l8 8M12 4l-8 8"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
              </svg>
              <span className="visually-hidden">Close panel</span>
            </button>
          </div>
          <StatusBar
            status={status}
            stream={stream}
            now={now}
            agencyName={agency.name}
            online={online}
            lastKnownAt={lastKnownAt}
          />
          <TransitSearch
            search={source.search}
            onRoute={(route) => openRoute(route.id)}
            onStop={(stop) => {
              showStop(stop.id);
              setCameraTarget({ lon: stop.lon, lat: stop.lat, zoom: 16 });
            }}
          />
        </header>

        <nav className="tabs" role="tablist">
          {(Object.keys(TAB_LABELS) as Tab[]).map((id) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              className={`tab${tab === id ? ' is-active' : ''}`}
              onClick={() => setTab(id)}
            >
              {TAB_LABELS[id]}
              {id === 'alerts' && activeAlertCount > 0 && (
                <span className="tab__count" aria-label={`${activeAlertCount} in effect`}>
                  {activeAlertCount}
                </span>
              )}
            </button>
          ))}
        </nav>

        <div className="sheet__body">
          {tab === 'plan' && (
            <div className="plan-tab">
              <PlaceSearch
                label="From"
                search={source.geocode}
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
                search={source.geocode}
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
                    <>
                      <LeaveNudge state={leave} now={now} />
                      <div className="plan-actions">
                        <button type="button" className="journey-start" onClick={startJourney}>
                          <span aria-hidden="true">▶</span>
                          Watch this trip
                        </button>
                        {origin && destination && (
                          <button
                            type="button"
                            className={`chip${savedCurrent ? ' chip--primary' : ''}`}
                            aria-pressed={Boolean(savedCurrent)}
                            title={
                              savedCurrent
                                ? 'Saved on this device. Tap to forget it.'
                                : 'Keep this trip, and track how its buses and trains run'
                            }
                            onClick={() =>
                              savedCurrent ? saved.remove(savedCurrent.id) : saved.save(origin, destination, chosen)
                            }
                          >
                            <span aria-hidden="true">{savedCurrent ? '★' : '☆'}</span> {savedCurrent ? 'Saved' : 'Save'}
                          </button>
                        )}
                        {origin && destination && (
                          <ShareButton
                            url={shareUrl({ from: origin, to: destination })}
                            title={`${origin.name} to ${destination.name}`}
                            note={
                              origin.kind === 'current-location'
                                ? 'your location is left out; they plan from theirs'
                                : undefined
                            }
                          />
                        )}
                      </div>
                      <ItineraryDetail
                        itinerary={chosen}
                        now={now}
                        onShowVehicle={(vehicleId) => showVehicle(vehicleId)}
                        onShowStop={showStop}
                        onRide={(vehicleId, stopId) => {
                          startRide(vehicleId, stopId);
                          showVehicle(vehicleId);
                        }}
                      />
                    </>
                  )}
                </>
              )}

              {!origin && !destination && !planning && (
                <SavedTrips
                  trips={saved.trips}
                  summaries={reliability}
                  onOpen={openSavedTrip}
                  onRemove={saved.remove}
                />
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
                        onClick={() => showStop(stop.id)}
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
            <RoutesTab
              routes={routes}
              activeRouteId={activeRouteId}
              activeDetail={activeRouteDetail}
              alertCounts={alertCounts}
              now={now}
              routesById={routesById}
              onSelect={showRoute}
              onClear={clearRoute}
              onShowRoute={openRoute}
            />
          )}

          {tab === 'status' && health && (
            <NetworkStatus health={health} onShowRoute={openRoute} />
          )}

          {tab === 'alerts' && (
            <AlertsView
              alerts={alerts}
              now={now}
              routes={routesById}
              onShowRoute={openRoute}
              onShownChange={showAlerts}
            />
          )}
        </div>
      </div>

      {detailOpen && (
        <DetailPanel
          kind={selectedPlaneId ? 'plane' : selectedVehicleId ? 'vehicle' : 'stop'}
          selectionKey={selectedPlaneId ?? selectedVehicleId ?? selectedStopId ?? ''}
          accent={selectedVehicleId ? selectedVehicle?.color : undefined}
          onClose={closeDetail}
        >
          {selectedPlaneId ? (
            selectedPlane ? (
              <PlanePanel
                plane={selectedPlane}
                source={planeStatus.source}
                home={{ lat: (agency.bbox[1] + agency.bbox[3]) / 2, lon: (agency.bbox[0] + agency.bbox[2]) / 2 }}
                details={planeDetails}
                route={planeRoute}
                bound={planeBound}
                onShowBound={() => {
                  if (!planeBound) return;
                  const arc = greatCircle(selectedPlane, planeBound.place, 32);
                  const lons = arc.map((p) => p[0]);
                  const lats = arc.map((p) => p[1]);
                  setCameraTarget({ bounds: [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)] });
                }}
              />
            ) : (
              <p className="panel-empty">
                This aircraft has left the area or stopped reporting its position.
              </p>
            )
          ) : selectedVehicleId ? (
            selectedVehicle ? (
              <VehiclePanel
                vehicle={selectedVehicle}
                trip={vehicleTrip}
                tripLoading={vehicleTripLoading}
                now={now}
                routes={routesById}
                onShowStop={showStop}
                onShowRoute={openRoute}
                ride={ride && ride.vehicleId === selectedVehicleId ? ride : null}
                explanation={lateness}
                onRide={(stopId) => {
                  if (stopId === false) setRide(null);
                  else startRide(selectedVehicleId, stopId);
                }}
              />
            ) : (
              <p className="panel-empty">
                Waiting for this vehicle to report its position. If it has just finished its trip, it may not
                appear again.
              </p>
            )
          ) : selectedStopId ? (
            <StopPanel
              stopId={selectedStopId}
              now={now}
              load={source.stopBoard}
              routes={routesById}
              onPlanFromHere={(detail) => planFromStop(detail, 'origin')}
              onPlanToHere={(detail) => planFromStop(detail, 'destination')}
              onShowRoute={openRoute}
              onShowVehicle={showVehicle}
              onRoutesLoaded={setHighlightRouteIds}
              onLoaded={(detail) =>
                setStopPin({ id: detail.stop.id, name: detail.stop.name, lat: detail.stop.lat, lon: detail.stop.lon })
              }
              reachShown={reach?.stopId === selectedStopId}
              reachLoading={reachLoading === selectedStopId}
              onReach={() => toggleReach(selectedStopId)}
            />
          ) : null}
        </DetailPanel>
      )}
    </div>
  );
}

/** The credit the aircraft feed is owed on the map. */
function planeCredit(source: string | null): string | null {
  switch (source) {
    case null:
      return null;
    case 'demo':
      return 'Aircraft simulated';
    case 'adsb.lol':
      return 'Aircraft <a href="https://adsb.lol" target="_blank" rel="noopener">adsb.lol</a> (ODbL)';
    case 'adsb.fi':
      return 'Aircraft <a href="https://adsb.fi" target="_blank" rel="noopener">adsb.fi</a>';
    default:
      return `Aircraft ${source.replace(/[<>&"]/g, '')}`;
  }
}
