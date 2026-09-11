import bindings from 'gtfs-realtime-bindings';
import type { Mode, ServiceAlert, Vehicle } from '../shared/api.js';
import type { GtfsStore } from '../gtfs/store.js';
import type { StopPrediction, TripUpdate } from './state.js';

const { transit_realtime: rt } = bindings;

/**
 * protobuf.js returns 64-bit fields as `Long` objects rather than numbers.
 * Every timestamp and delay in these feeds fits comfortably in a JS number, so
 * normalise them at the boundary and deal only in numbers past this point.
 */
function toNumber(value: number | Long | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  return typeof value.toNumber === 'function' ? value.toNumber() : null;
}

/**
 * Reads a GTFS-Realtime timestamp, treating zero as absent.
 *
 * Protobuf has no concept of an unset scalar: a producer that omits a
 * `uint64 timestamp` is indistinguishable on the wire from one that sends 0,
 * and the decoder yields 0 either way. Since a real epoch timestamp of 0 would
 * mean 1970, zero always means "not reported" here — and treating it as a
 * genuine value would date every such vehicle to the Unix epoch.
 */
function toTimestamp(value: number | Long | null | undefined): number | null {
  const n = toNumber(value);
  return n === null || n === 0 ? null : n;
}

/** Picks the best translation from a GTFS-RT TranslatedString. */
function translated(
  value: { translation?: ({ text?: string | null; language?: string | null } | null)[] | null } | null | undefined,
  language = 'en',
): string {
  const translations = value?.translation;
  if (!translations || translations.length === 0) return '';
  const exact = translations.find((t) => t?.language?.toLowerCase().startsWith(language));
  return (exact?.text ?? translations[0]?.text ?? '').trim();
}

function enumName(table: Record<string, string | number>, value: number | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  for (const [name, v] of Object.entries(table)) {
    if (v === value && Number.isNaN(Number(name))) return name;
  }
  return undefined;
}

/** Decodes a FeedMessage, throwing a readable error on malformed input. */
function decodeFeed(buffer: Uint8Array) {
  try {
    return rt.FeedMessage.decode(buffer);
  } catch (err) {
    const head = Buffer.from(buffer.subarray(0, 24)).toString('utf8');
    // A common failure is an HTML error page served with a .pb URL; say so
    // rather than surfacing a bare protobuf wire-format error.
    if (/^\s*(<|\{)/.test(head)) {
      throw new Error('feed returned markup or JSON where a protobuf was expected');
    }
    throw err;
  }
}

export function decodeVehiclePositions(buffer: Uint8Array, store: GtfsStore | null): Vehicle[] {
  const feed = decodeFeed(buffer);
  const feedTimestamp = toTimestamp(feed.header?.timestamp) ?? Math.floor(Date.now() / 1000);
  const vehicles: Vehicle[] = [];

  for (const entity of feed.entity ?? []) {
    const v = entity.vehicle;
    const position = v?.position;
    if (!v || !position) continue;

    const lat = position.latitude;
    const lon = position.longitude;
    // Feeds routinely include vehicles parked at 0,0 before they log on.
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) continue;

    const tripId = v.trip?.tripId ?? undefined;
    const tripIdx = tripId !== undefined ? store?.tripIndexById.get(tripId) : undefined;

    let routeId = v.trip?.routeId ?? undefined;
    let routeShortName: string | undefined;
    let mode: Mode = 'bus';
    let color = '0B5FA5';
    let headsign: string | undefined;
    let directionId: number | undefined;

    if (store && tripIdx !== undefined) {
      const route = store.routes[store.tripRoute[tripIdx]];
      routeId = route.id;
      routeShortName = route.shortName;
      mode = route.mode;
      color = route.color;
      headsign = store.tripHeadsigns[tripIdx] || undefined;
      directionId = store.tripDirection[tripIdx];
    } else if (store && routeId) {
      const route = store.routeById(routeId);
      if (route) {
        routeShortName = route.shortName;
        mode = route.mode;
        color = route.color;
      }
    }

    const id = v.vehicle?.id ?? v.vehicle?.label ?? entity.id;
    if (!id) continue;

    vehicles.push({
      id,
      tripId,
      routeId,
      routeShortName,
      mode,
      color,
      lat,
      lon,
      bearing: Number.isFinite(position.bearing) ? (position.bearing as number) : undefined,
      speed: Number.isFinite(position.speed) ? (position.speed as number) : undefined,
      headsign,
      directionId,
      timestamp: toTimestamp(v.timestamp) ?? feedTimestamp,
      occupancy: enumName(
        rt.VehiclePosition.OccupancyStatus as unknown as Record<string, string | number>,
        v.occupancyStatus,
      ),
    });
  }

  return vehicles;
}

export function decodeTripUpdates(buffer: Uint8Array): TripUpdate[] {
  const feed = decodeFeed(buffer);
  const feedTimestamp = toTimestamp(feed.header?.timestamp) ?? Math.floor(Date.now() / 1000);
  const updates: TripUpdate[] = [];

  for (const entity of feed.entity ?? []) {
    const u = entity.tripUpdate;
    const tripId = u?.trip?.tripId;
    if (!u || !tripId) continue;

    const stops = new Map<string, StopPrediction>();
    for (const stu of u.stopTimeUpdate ?? []) {
      const stopId = stu.stopId;
      if (!stopId) continue;
      // SKIPPED (1) means the vehicle will not serve this stop at all.
      if (stu.scheduleRelationship === rt.TripUpdate.StopTimeUpdate.ScheduleRelationship.SKIPPED) {
        stops.set(stopId, { delaySeconds: null, arrivalTime: null, departureTime: null });
        continue;
      }
      const arrivalDelay = toNumber(stu.arrival?.delay);
      const departureDelay = toNumber(stu.departure?.delay);
      stops.set(stopId, {
        delaySeconds: departureDelay ?? arrivalDelay,
        arrivalTime: toNumber(stu.arrival?.time),
        departureTime: toNumber(stu.departure?.time),
      });
    }

    updates.push({
      tripId,
      routeId: u.trip?.routeId ?? undefined,
      stops,
      tripDelaySeconds: toNumber(u.delay),
      cancelled: u.trip?.scheduleRelationship === rt.TripDescriptor.ScheduleRelationship.CANCELED,
      timestamp: toTimestamp(u.timestamp) ?? feedTimestamp,
    });
  }

  return updates;
}

export function decodeAlerts(buffer: Uint8Array): ServiceAlert[] {
  const feed = decodeFeed(buffer);
  const alerts: ServiceAlert[] = [];

  for (const entity of feed.entity ?? []) {
    const a = entity.alert;
    if (!a) continue;

    const routeIds = new Set<string>();
    const stopIds = new Set<string>();
    for (const informed of a.informedEntity ?? []) {
      if (informed.routeId) routeIds.add(informed.routeId);
      if (informed.stopId) stopIds.add(informed.stopId);
      if (informed.trip?.routeId) routeIds.add(informed.trip.routeId);
    }

    const period = a.activePeriod?.[0];
    const header = translated(a.headerText);
    const description = translated(a.descriptionText);
    if (!header && !description) continue;

    alerts.push({
      id: entity.id || `${header}:${[...routeIds].join(',')}`,
      header,
      description,
      cause: enumName(rt.Alert.Cause as unknown as Record<string, string | number>, a.cause),
      effect: enumName(rt.Alert.Effect as unknown as Record<string, string | number>, a.effect),
      url: translated(a.url) || undefined,
      routeIds: [...routeIds],
      stopIds: [...stopIds],
      activeFrom: toTimestamp(period?.start) ?? undefined,
      activeUntil: toTimestamp(period?.end) ?? undefined,
    });
  }

  return alerts;
}
