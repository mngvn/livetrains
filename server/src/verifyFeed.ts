import { loadConfig } from './config.js';
import { log } from './log.js';
import { TransitService } from './service.js';

/**
 * Loads an agency's real feed and exercises the planner against it.
 *
 * The unit tests deliberately use a synthetic feed so they are fast and
 * offline. This is the complement: proof that the actual published data still
 * parses, still contains running service, and still yields a usable itinerary.
 * Run on a schedule in CI, it turns an upstream change into a failed job
 * instead of a broken app.
 */
async function main(): Promise<void> {
  const started = Date.now();
  const service = new TransitService(loadConfig());
  await service.start();

  const store = service.store;
  const planner = service.planner;
  if (!store || !planner) throw new Error('the feed did not load');

  const loadSeconds = ((Date.now() - started) / 1000).toFixed(1);
  log.info(`verify: loaded in ${loadSeconds}s`);
  log.info(
    `verify: ${store.stops.length} stops, ${store.routes.length} routes, ` +
      `${store.tripIds.length} trips, ${store.stopTimeCount} stop times`,
  );

  if (store.stops.length === 0) throw new Error('the feed contains no stops');
  if (store.tripIds.length === 0) throw new Error('the feed contains no trips');

  // Service must actually be running on some upcoming date; a feed that parses
  // but has expired is worse than one that fails outright, because the app
  // would look fine and simply never find a trip.
  const today = Number(new Date().toISOString().slice(0, 10).replace(/-/g, ''));
  const nextServiceDate = store.lastServiceDate(today);
  if (nextServiceDate === null) throw new Error('the feed has no service on any upcoming date');
  log.info(`verify: next service date ${nextServiceDate}`);

  // Downtown Minneapolis to downtown St Paul: a trip that must always exist.
  const planStarted = Date.now();
  const plan = planner.plan({
    fromLat: 44.9778,
    fromLon: -93.2650,
    toLat: 44.9475,
    toLon: -93.0936,
  });
  log.info(`verify: planned in ${Date.now() - planStarted}ms`);

  if (plan.itineraries.length === 0) {
    throw new Error(`no itinerary found: ${plan.message ?? 'no reason given'}`);
  }

  const best = plan.itineraries[0];
  const legs = best.legs
    .map((leg) => (leg.type === 'transit' ? leg.route.shortName : 'walk'))
    .join(' → ');
  log.info(
    `verify: best itinerary ${Math.round(best.durationSeconds / 60)} min, ` +
      `${best.transfers} transfer(s): ${legs}`,
  );

  const realtime = service.status().realtime;
  log.info(
    `verify: realtime has ${realtime.vehicles} vehicles, ` +
      `${realtime.tripUpdates} trip updates, ${realtime.alerts} alerts`,
  );

  service.stop();
  log.info('verify: OK');
}

main().catch((err: unknown) => {
  log.error('verify: FAILED', err);
  process.exit(1);
});
