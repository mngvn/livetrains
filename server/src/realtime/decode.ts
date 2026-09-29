import bindings from 'gtfs-realtime-bindings';
import type { InformedEntity, Mode, ServiceAlert, Vehicle } from '../shared/api.js';
import type { GtfsStore } from '../gtfs/store.js';
import { accessibility } from '../summaries.js';
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

/**
 * Reads a field only if the producer actually sent it.
 *
 * protobufjs puts a field's default on the message *prototype* rather than
 * leaving it undefined, so reading an unsent `int64 time` yields a Long zero
 * and an unsent `int32 delay` yields 0 — both indistinguishable, by value,
 * from a real reading. That is not academic here: a stop predicted by delay
 * alone would read as having a predicted *time* of midnight 1970, and the
 * departure board would drop it as long gone; a stop predicted by time alone
 * would read as having a delay of exactly zero, and show as on time whatever
 * the prediction said. Fields the decoder actually read are own properties,
 * so that is the test.
 */
function sent(message: object | null | undefined, field: string): boolean {
  return message !== null && message !== undefined && Object.prototype.hasOwnProperty.call(message, field);
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

/** VehicleStopStatus, as the three words the client shows. */
function statusName(value: number | null | undefined): Vehicle['currentStatus'] {
  switch (value) {
    case rt.VehiclePosition.VehicleStopStatus.INCOMING_AT:
      return 'incoming';
    case rt.VehiclePosition.VehicleStopStatus.STOPPED_AT:
      return 'stopped';
    case rt.VehiclePosition.VehicleStopStatus.IN_TRANSIT_TO:
      return 'in-transit';
    default:
      return undefined;
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
    let wheelchair: Vehicle['wheelchair'];

    if (store && tripIdx !== undefined) {
      const route = store.routes[store.tripRoute[tripIdx]];
      routeId = route.id;
      routeShortName = route.shortName;
      mode = route.mode;
      color = route.color;
      headsign = store.tripHeadsigns[tripIdx] || undefined;
      directionId = store.tripDirection[tripIdx];
      wheelchair = accessibility(store.tripWheelchair[tripIdx]);
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
      // Each optional field is read only if it was sent. Unsent, protobufjs
      // reads bearing and speed as 0 — a heading arrow pointing north on a
      // vehicle that never reported one — and occupancy as its enum's zero,
      // which is EMPTY: every bus on a feed that omits occupancy showed as
      // empty.
      bearing:
        sent(position, 'bearing') && Number.isFinite(position.bearing) ? (position.bearing as number) : undefined,
      speed: sent(position, 'speed') && Number.isFinite(position.speed) ? (position.speed as number) : undefined,
      headsign,
      directionId,
      timestamp: toTimestamp(v.timestamp) ?? feedTimestamp,
      stopId: v.stopId || undefined,
      currentStatus: sent(v, 'currentStatus') ? statusName(v.currentStatus) : undefined,
      occupancy: sent(v, 'occupancyStatus')
        ? enumName(
            rt.VehiclePosition.OccupancyStatus as unknown as Record<string, string | number>,
            v.occupancyStatus,
          )
        : undefined,
      wheelchair,
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
        stops.set(stopId, { delaySeconds: null, arrivalTime: null, departureTime: null, skipped: true });
        continue;
      }
      const arrivalDelay = sent(stu.arrival, 'delay') ? toNumber(stu.arrival?.delay) : null;
      const departureDelay = sent(stu.departure, 'delay') ? toNumber(stu.departure?.delay) : null;
      stops.set(stopId, {
        delaySeconds: departureDelay ?? arrivalDelay,
        // Zero is "not sent" as well as "unset": an epoch of 0 is 1970.
        arrivalTime: sent(stu.arrival, 'time') ? toTimestamp(stu.arrival?.time) : null,
        departureTime: sent(stu.departure, 'time') ? toTimestamp(stu.departure?.time) : null,
        skipped: false,
      });
    }

    updates.push({
      tripId,
      routeId: u.trip?.routeId ?? undefined,
      stops,
      tripDelaySeconds: sent(u, 'delay') ? toNumber(u.delay) : null,
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
    const informed: InformedEntity[] = [];
    for (const e of a.informedEntity ?? []) {
      const entry: InformedEntity = {};
      if (e.agencyId) entry.agencyId = e.agencyId;
      const routeId = e.routeId || e.trip?.routeId || undefined;
      if (routeId) {
        entry.routeId = routeId;
        routeIds.add(routeId);
      }
      if (e.stopId) {
        entry.stopId = e.stopId;
        stopIds.add(e.stopId);
      }
      if (e.trip?.tripId) entry.tripId = e.trip.tripId;
      if (Object.keys(entry).length > 0) informed.push(entry);
    }

    const periods = (a.activePeriod ?? []).map((p) => ({
      start: toTimestamp(p?.start) ?? undefined,
      end: toTimestamp(p?.end) ?? undefined,
    }));
    const header = translated(a.headerText);
    const description = translated(a.descriptionText);
    if (!header && !description) continue;

    alerts.push({
      id: entity.id || `${header}:${[...routeIds].join(',')}`,
      header,
      description,
      // Enums read only when sent: an unsent cause would otherwise read as
      // its zero value, which in these enums is not "unknown" but a real one.
      cause: sent(a, 'cause')
        ? enumName(rt.Alert.Cause as unknown as Record<string, string | number>, a.cause)
        : undefined,
      effect: sent(a, 'effect')
        ? enumName(rt.Alert.Effect as unknown as Record<string, string | number>, a.effect)
        : undefined,
      url: translated(a.url) || undefined,
      routeIds: [...routeIds],
      stopIds: [...stopIds],
      informed,
      activeFrom: periods[0]?.start,
      activeUntil: periods[0]?.end,
      periods,
    });
  }

  return alerts;
}
