import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import bindings from 'gtfs-realtime-bindings';
import { buildMockGtfs } from './feed.js';
import { createMockStore, MockSimulator } from './index.js';
import { log } from '../log.js';

const { transit_realtime: rt } = bindings;

/**
 * Writes the synthetic feed to disk as real GTFS and GTFS-Realtime files.
 *
 * The demo feed normally lives only in memory, which the Node server can use
 * directly. A browser cannot: in static mode the app fetches a `.zip` and
 * `.pb` files over HTTP exactly as it would from a real agency. Emitting the
 * mock in that same wire format means the static build can be developed and
 * tested end to end with no network and no dependency on an agency's uptime.
 */
export async function writeFixtures(outDir: string): Promise<void> {
  await mkdir(outDir, { recursive: true });

  const files = buildMockGtfs();
  const entries: Record<string, Uint8Array> = {};
  for (const [name, contents] of files) entries[name] = strToU8(contents);
  await writeFile(join(outDir, 'gtfs.zip'), zipSync(entries, { level: 6 }));

  const store = createMockStore();
  const simulator = new MockSimulator(store);
  const now = Math.floor(Date.now() / 1000);

  await writeFile(join(outDir, 'vehiclepositions.pb'), encodeVehicles(simulator, now));
  await writeFile(join(outDir, 'tripupdates.pb'), encodeTripUpdates(simulator, now));
  await writeFile(join(outDir, 'alerts.pb'), encodeAlerts(simulator));

  log.info(
    `fixtures: wrote gtfs.zip and 3 realtime feeds to ${outDir} ` +
      `(${store.stops.length} stops, ${store.tripIds.length} trips)`,
  );
}

function encodeVehicles(simulator: MockSimulator, now: number): Buffer {
  const message = rt.FeedMessage.create({
    header: { gtfsRealtimeVersion: '2.0', timestamp: now },
    entity: simulator.vehicles(now).map((v) => ({
      id: v.id,
      vehicle: {
        trip: { tripId: v.tripId, routeId: v.routeId },
        vehicle: { id: v.id, label: v.id },
        position: { latitude: v.lat, longitude: v.lon, bearing: v.bearing, speed: v.speed },
        timestamp: v.timestamp,
      },
    })),
  });
  return Buffer.from(rt.FeedMessage.encode(message).finish());
}

function encodeTripUpdates(simulator: MockSimulator, now: number): Buffer {
  const message = rt.FeedMessage.create({
    header: { gtfsRealtimeVersion: '2.0', timestamp: now },
    entity: simulator.tripUpdates(now).map((update, index) => ({
      id: `tu-${index}`,
      tripUpdate: {
        trip: { tripId: update.tripId, routeId: update.routeId },
        delay: update.tripDelaySeconds ?? 0,
        timestamp: update.timestamp,
        stopTimeUpdate: [...update.stops].map(([stopId, prediction]) => ({
          stopId,
          arrival: prediction.arrivalTime ? { time: prediction.arrivalTime, delay: prediction.delaySeconds ?? 0 } : undefined,
          departure: prediction.departureTime
            ? { time: prediction.departureTime, delay: prediction.delaySeconds ?? 0 }
            : undefined,
        })),
      },
    })),
  });
  return Buffer.from(rt.FeedMessage.encode(message).finish());
}

function encodeAlerts(simulator: MockSimulator): Buffer {
  const message = rt.FeedMessage.create({
    header: { gtfsRealtimeVersion: '2.0', timestamp: Math.floor(Date.now() / 1000) },
    entity: simulator.alerts().map((alert) => ({
      id: alert.id,
      alert: {
        informedEntity: [
          ...alert.routeIds.map((routeId) => ({ routeId })),
          ...alert.stopIds.map((stopId) => ({ stopId })),
        ],
        headerText: { translation: [{ text: alert.header, language: 'en' }] },
        descriptionText: { translation: [{ text: alert.description, language: 'en' }] },
      },
    })),
  });
  return Buffer.from(rt.FeedMessage.encode(message).finish());
}

// Allow running directly: `tsx src/mock/fixtures.ts <outDir>`
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  const target = process.argv[2] ?? join(process.cwd(), 'fixtures');
  writeFixtures(target).catch((err: unknown) => {
    log.error('fixtures: failed', err);
    process.exit(1);
  });
}
