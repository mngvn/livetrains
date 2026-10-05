import type { Plane } from '@shared/planes.ts';
import { relativeAge } from '../lib/format.ts';
import {
  PLANE_PATH,
  compassWord,
  flightName,
  planeHeight,
  planeSpeedMph,
  planeTrend,
} from '../lib/planeInfo.ts';
import { distanceToKm, type Airport, type PlaneDetails } from '../lib/planeLookup.ts';
import { flyingTime, type Bound } from '../lib/planeBound.ts';

/**
 * The selected aircraft: who it is, where it is going, how high and how fast.
 *
 * Planes are not something this app plans with, so the panel is short and
 * plain — the questions anyone looking up at one asks — and says where every
 * fact came from, because a crowd-sourced route can be wrong.
 */
export function PlanePanel({
  plane,
  source,
  home,
  details,
  route,
  bound,
  onShowBound,
}: {
  plane: Plane;
  /** Who the position came from: "adsb.lol". */
  source: string | null;
  /** The middle of the transit area, for "arriving at" and "leaving". */
  home: { lat: number; lon: number };
  /** What adsbdb knows about it, once looked up. */
  details: PlaneDetails | null | 'loading';
  /** Its published route, only when it is actually flying it. */
  route: PlaneDetails['route'];
  /** Where it is going, as well as can be told. */
  bound: Bound | null;
  /** Fit the map to the plane and where it is going. */
  onShowBound: () => void;
}) {
  const loaded = details !== 'loading' && details !== null ? details : null;
  const name = flightName(plane);
  const aircraft = loaded?.aircraft ?? null;
  const type = aircraftType(plane, aircraft);
  const mph = planeSpeedMph(plane);
  const trend = planeTrend(plane);
  const emergency = emergencyText(plane);
  const subtitle = [
    plane.callsign && plane.callsign !== name.title ? plane.callsign : null,
    route?.airline && route.airline !== name.airline ? route.airline : (name.brand ?? null),
  ].filter(Boolean);

  return (
    <div className="plane-panel">
      <header className="panel-header">
        <div className="panel-header__text">
          <h2 className="panel-title">{name.title}</h2>
          <p className="panel-subtitle">{subtitle.length > 0 ? subtitle.join(' · ') : type ?? 'Aircraft'}</p>
        </div>
      </header>

      {emergency && <p className="plane-panel__emergency">{emergency}</p>}

      {route && <RouteLine origin={route.origin} destination={route.destination} plane={plane} />}

      <p className="plane-panel__where">{whereNow(plane, route, home)}</p>

      {bound && (
        <section className={`plane-bound plane-bound--${bound.kind}`} aria-label="Where it is going">
          <h3 className="panel-section__title">Where it’s going</h3>
          <p className="plane-bound__headline">{boundHeadline(bound, plane)}</p>
          <p className="plane-bound__detail">{boundDetail(bound, plane, home, Boolean(loaded?.route && !route))}</p>
          <button type="button" className="chip" onClick={onShowBound}>
            Show on the map
          </button>
        </section>
      )}

      <div className="vehicle-panel__tags">
        {mph !== null && mph > 0 && <span className="fact-tag">{mph} mph</span>}
        {plane.track !== undefined && !plane.onGround && (
          <span className="fact-tag">Heading {compassWord(plane.track)}</span>
        )}
        {trend && trend !== 'level' && plane.verticalRate !== undefined && (
          <span className="fact-tag">
            {trend === 'climbing' ? 'Climbing' : 'Descending'} {Math.abs(Math.round(plane.verticalRate / 100) * 100).toLocaleString('en-US')} ft/min
          </span>
        )}
        <span className="fact-tag fact-tag--muted">Position {relativeAge(plane.positionAt)}</span>
      </div>

      <section className="panel-section">
        <h3 className="panel-section__title">Aircraft</h3>
        <div className="plane-panel__aircraft">
          {aircraft?.photo && (
            <img
              className="plane-panel__photo"
              src={aircraft.photo}
              alt={type ? `A ${type}` : 'The aircraft'}
              loading="lazy"
              referrerPolicy="no-referrer"
              onError={(event) => {
                event.currentTarget.style.display = 'none';
              }}
            />
          )}
          <dl className="plane-panel__facts">
            {type && (
              <>
                <dt>Type</dt>
                <dd>{type}</dd>
              </>
            )}
            {(aircraft?.registration ?? plane.registration) && (
              <>
                <dt>Registration</dt>
                <dd>{aircraft?.registration ?? plane.registration}</dd>
              </>
            )}
            {(aircraft?.owner ?? plane.owner) && (
              <>
                <dt>Owner</dt>
                <dd>{titleCase(aircraft?.owner ?? plane.owner ?? '')}</dd>
              </>
            )}
            {route?.flight && (
              <>
                <dt>Flight</dt>
                <dd>{route.flight}</dd>
              </>
            )}
            {plane.altitude !== undefined && !plane.onGround && (
              <>
                <dt>Altitude</dt>
                <dd>{planeHeight(plane)}</dd>
              </>
            )}
            {plane.squawk && (
              <>
                <dt>Squawk</dt>
                <dd>{plane.squawk}</dd>
              </>
            )}
          </dl>
        </div>
        {details === 'loading' && <p className="panel-loading">Looking it up…</p>}
      </section>

      <div className="panel-actions">
        {!plane.id.startsWith('~') && (
          <a
            className="chip"
            href={`https://globe.adsb.lol/?icao=${encodeURIComponent(plane.id)}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Full track on adsb.lol <span aria-hidden="true">↗</span>
          </a>
        )}
      </div>

      <p className="plane-panel__credit">
        Position from {sourceName(source)}.
        {loaded && (loaded.aircraft || loaded.route) && ' Aircraft and route from adsbdb.com: a route is what the flight number usually flies.'}
        {loaded?.route && !route && ' The route listed for it does not pass anywhere near here, so it is left out.'}
      </p>
    </div>
  );
}

function RouteLine({ origin, destination, plane }: { origin: Airport; destination: Airport; plane: Plane }) {
  // How far along: the share of the trip already flown, by distance.
  const flown = distanceToKm(origin, plane);
  const left = distanceToKm(plane, destination);
  const progress = flown + left > 0 ? Math.min(1, Math.max(0, flown / (flown + left))) : 0;
  return (
    <div className="plane-route" aria-label={`From ${origin.city || origin.name} to ${destination.city || destination.name}`}>
      <div className="plane-route__end">
        <span className="plane-route__code">{origin.iata}</span>
        <span className="plane-route__city">{origin.city || origin.name}</span>
      </div>
      <div className="plane-route__track" aria-hidden="true">
        <span className="plane-route__flown" style={{ width: `${progress * 100}%` }} />
        <span className="plane-route__plane" style={{ left: `${progress * 100}%` }}>
          <svg viewBox="0 0 40 40" width="16" height="16">
            <path d={PLANE_PATH} fill="currentColor" transform="rotate(90 20 20)" />
          </svg>
        </span>
      </div>
      <div className="plane-route__end plane-route__end--to">
        <span className="plane-route__code">{destination.iata}</span>
        <span className="plane-route__city">{destination.city || destination.name}</span>
      </div>
    </div>
  );
}

/** "Bound for Atlanta (ATL)", "Landing at Flying Cloud (FCM)", "Heading west, towards Fargo". */
function boundHeadline(bound: Bound, plane: Plane): string {
  const { name, code } = bound.place;
  switch (bound.kind) {
    case 'destination':
      return `Bound for ${name} (${code})`;
    case 'landing':
      return `Looks like it is landing at ${name} (${code})`;
    case 'toward':
      return `Heading ${compassWord(plane.track ?? 0)}, towards ${name}`;
  }
}

/** How far, how long, and how sure. */
function boundDetail(bound: Bound, plane: Plane, home: { lat: number; lon: number }, routeRejected: boolean): string {
  const unknown = routeRejected
    ? 'The route listed for this flight number does not match where it is'
    : 'No route is published for this flight';
  const miles = bound.miles < 10 ? bound.miles.toFixed(1) : Math.round(bound.miles).toLocaleString('en-US');
  const time = bound.minutes === null ? '' : `, ${flyingTime(bound.minutes)} at its current speed`;
  switch (bound.kind) {
    case 'destination': {
      // An arrival here is about to land; say so, rather than "N miles to go".
      const arriving = distanceToKm(bound.place, home) < 80 && planeTrend(plane) === 'descending';
      return arriving
        ? `On its way in: ${miles} mi out${time}.`
        : `${miles} mi to go${time}. Its scheduled route, from adsbdb.com.`;
    }
    case 'landing':
      return `${miles} mi ahead, low and coming down. A guess from its height and heading: ${unknown.charAt(0).toLowerCase()}${unknown.slice(1)}.`;
    case 'toward':
      return `${miles} mi that way${time}. ${unknown}, so this is just the way it is flying.`;
  }
}

function sourceName(source: string | null): string {
  if (source === 'demo') return 'the demo feed: these planes are simulated';
  if (source === 'adsb.lol') return 'adsb.lol, a community ADS-B network (ODbL)';
  if (source) return `${source}, a community ADS-B network`;
  return 'a community ADS-B network';
}

/** "Airbus A321", from the lookup where it has one, else the feed's own words. */
function aircraftType(plane: Plane, aircraft: PlaneDetails['aircraft']): string | null {
  if (aircraft?.manufacturer && aircraft.type) {
    return aircraft.type.toLowerCase().startsWith(aircraft.manufacturer.toLowerCase())
      ? aircraft.type
      : `${aircraft.manufacturer} ${aircraft.type}`;
  }
  if (plane.typeName) return titleCase(plane.typeName);
  return plane.typeCode ?? null;
}

/** "DELTA AIR LINES INC" reads as shouting; "Delta Air Lines Inc" does not. */
function titleCase(text: string): string {
  if (text !== text.toUpperCase()) return text;
  return text
    .toLowerCase()
    .replace(/\b([a-z])/g, (c) => c.toUpperCase())
    .replace(/\b(Llc|Usa|Ii|Iii)\b/g, (w) => w.toUpperCase());
}

/** A plane telling air traffic control it is in trouble. */
function emergencyText(plane: Plane): string | null {
  switch (plane.squawk) {
    case '7700':
      return 'Squawking 7700: declaring an emergency';
    case '7600':
      return 'Squawking 7600: lost radio contact';
    case '7500':
      return 'Squawking 7500';
  }
  if (plane.emergency) return `Emergency status: ${plane.emergency}`;
  return null;
}

/**
 * Where it is in its flight, in a sentence: "Descending into Minneapolis,
 * 3,400 ft", "Climbing out of Minneapolis", "Cruising at 35,000 ft".
 */
function whereNow(plane: Plane, route: PlaneDetails['route'], home: { lat: number; lon: number }): string {
  const height = planeHeight(plane);
  if (plane.onGround) return 'On the ground';
  const trend = planeTrend(plane);
  const near = (a: Airport) => distanceToKm(a, home) < 80;
  if (route && trend === 'descending' && near(route.destination)) {
    return `Descending into ${route.destination.city || route.destination.name}, ${height}`;
  }
  if (route && trend === 'climbing' && near(route.origin)) {
    return `Climbing out of ${route.origin.city || route.origin.name}, ${height}`;
  }
  if (!height) return 'Height not reported';
  if (trend === 'climbing') return `Climbing through ${height}`;
  if (trend === 'descending') return `Descending through ${height}`;
  if ((plane.altitude ?? 0) >= 18000) return `Cruising at ${height}`;
  return `Flying at ${height}`;
}
