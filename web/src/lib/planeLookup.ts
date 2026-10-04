import { useEffect, useState } from 'react';
import type { Plane } from '@shared/planes.ts';

/**
 * What an aircraft is and where it is going, looked up once it is chosen.
 *
 * Positions say little beyond a callsign and a type code. adsbdb.com, a free
 * keyless database that (unlike the position feeds) answers browsers
 * directly, fills in the rest: the airframe from its transponder address, and
 * the route the flight number is scheduled to fly. Looked up only for the
 * plane someone taps, and remembered for the visit.
 */

export interface Airport {
  iata: string;
  icao: string;
  name: string;
  city: string;
  lat: number;
  lon: number;
}

export interface PlaneDetails {
  aircraft: {
    manufacturer?: string;
    type?: string;
    registration?: string;
    owner?: string;
    photo?: string;
  } | null;
  route: {
    airline?: string;
    /** "DL447". */
    flight?: string;
    origin: Airport;
    destination: Airport;
  } | null;
}

const API = 'https://api.adsbdb.com/v0';

const cache = new Map<string, Promise<PlaneDetails>>();

type Json = Record<string, unknown>;
const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

function airport(value: unknown): Airport | null {
  if (!value || typeof value !== 'object') return null;
  const a = value as Json;
  const lat = Number(a.latitude);
  const lon = Number(a.longitude);
  const iata = str(a.iata_code);
  const icao = str(a.icao_code);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !(iata || icao)) return null;
  return { iata: iata ?? icao!, icao: icao ?? iata!, name: str(a.name) ?? '', city: str(a.municipality) ?? '', lat, lon };
}

async function getJson(url: string, signal?: AbortSignal): Promise<Json | null> {
  try {
    const response = await fetch(url, { signal });
    if (!response.ok) return null;
    const body = (await response.json()) as { response?: unknown };
    return body.response && typeof body.response === 'object' ? (body.response as Json) : null;
  } catch {
    return null;
  }
}

/** An airline callsign: three letters and a flight number. Tail numbers fly no route. */
const AIRLINE_CALLSIGN = /^[A-Z]{3}\d[0-9A-Z]{0,3}$/;

export function lookUpPlane(plane: Pick<Plane, 'id' | 'callsign'>): Promise<PlaneDetails> {
  const key = `${plane.id}|${plane.callsign ?? ''}`;
  let pending = cache.get(key);
  if (!pending) {
    pending = (async () => {
      const [aircraftBody, routeBody] = await Promise.all([
        plane.id.startsWith('~') ? null : getJson(`${API}/aircraft/${encodeURIComponent(plane.id)}`),
        plane.callsign && AIRLINE_CALLSIGN.test(plane.callsign)
          ? getJson(`${API}/callsign/${encodeURIComponent(plane.callsign)}`)
          : null,
      ]);
      const a = aircraftBody?.aircraft as Json | undefined;
      const r = routeBody?.flightroute as Json | undefined;
      const origin = airport(r?.origin);
      const destination = airport(r?.destination);
      return {
        aircraft: a
          ? {
              manufacturer: str(a.manufacturer),
              type: str(a.type),
              registration: str(a.registration),
              owner: str(a.registered_owner),
              photo: str(a.url_photo_thumbnail),
            }
          : null,
        route:
          origin && destination
            ? {
                airline: str((r?.airline as Json | undefined)?.name),
                flight: str(r?.callsign_iata),
                origin,
                destination,
              }
            : null,
      };
    })();
    cache.set(key, pending);
  }
  return pending;
}

const EARTH_KM = 6371;

function km(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(h));
}

/**
 * Whether a looked-up route is one this plane could actually be flying.
 *
 * Route databases record what a flight number usually flies, and airlines
 * reuse numbers: a Delta 447 crossing Minneapolis may be listed as New York
 * to Atlanta. A plane on its route is near one end of it, or not far off the
 * line between them; anything else is somebody else's flight, and saying
 * nothing beats saying the wrong thing.
 */
export function routeFits(
  route: { origin: Airport; destination: Airport },
  plane: { lat: number; lon: number },
): boolean {
  const toOrigin = km(plane, route.origin);
  const toDestination = km(plane, route.destination);
  if (Math.min(toOrigin, toDestination) < 60) return true;
  const direct = km(route.origin, route.destination);
  return toOrigin + toDestination - direct < Math.max(150, direct * 0.12);
}

/** How far a plane is from an airport, in kilometres. */
export function distanceToKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  return km(a, b);
}

/** The details of the plane being looked at, once they arrive. */
export function usePlaneDetails(plane: Pick<Plane, 'id' | 'callsign'> | null): PlaneDetails | null | 'loading' {
  const id = plane?.id ?? null;
  const callsign = plane?.callsign;
  const [details, setDetails] = useState<{ key: string; value: PlaneDetails } | null>(null);
  const key = id ? `${id}|${callsign ?? ''}` : null;
  useEffect(() => {
    if (!id || !key) return;
    let cancelled = false;
    void lookUpPlane({ id, callsign }).then((value) => {
      if (!cancelled) setDetails({ key, value });
    });
    return () => {
      cancelled = true;
    };
  }, [id, callsign, key]);
  if (!key) return null;
  return details?.key === key ? details.value : 'loading';
}
