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

  // Realtime. This used to log whatever the counts happened to be — before
  // the first poll had even returned — and pass regardless, which is how a
  // run reporting "0 vehicles, 0 trip updates, 0 alerts" could still say OK.
  // Now it waits for a complete poll and requires every configured feed to
  // have produced something.
  const feeds = service.config.agency.realtime;
  const realtime = await firstCompletePoll(service, feeds, 45_000);
  log.info(
    `verify: realtime has ${realtime.vehicles} vehicles, ` +
      `${realtime.tripUpdates} trip updates, ${realtime.alerts} alerts` +
      (realtime.lastError ? ` (errors: ${realtime.lastError})` : ''),
  );

  const problems: string[] = [];
  if (realtime.lastError) problems.push(realtime.lastError);
  // Vehicles and trip updates are never legitimately empty for a metro system
  // in service; alerts can be, so they only have to have loaded.
  if (feeds.vehiclePositions && realtime.vehicles === 0) problems.push('the vehicle feed has no vehicles');
  if (feeds.tripUpdates && realtime.tripUpdates === 0) problems.push('the trip update feed has no updates');

  if (realtime.vehicles > 0) {
    const withDelay = [...service.realtime.vehicles.values()].filter((v) => v.delaySeconds !== undefined).length;
    log.info(`verify: ${withDelay} of ${realtime.vehicles} vehicles have a delay worked out`);
  }

  service.stop();
  if (problems.length > 0) throw new Error(`realtime: ${problems.join('; ')}`);
  log.info('verify: OK');
}

/**
 * Resolves once every configured realtime feed has answered at least once —
 * successfully or not — or when the deadline passes.
 */
async function firstCompletePoll(
  service: TransitService,
  feeds: { vehiclePositions?: string; tripUpdates?: string; alerts?: string },
  timeoutMs: number,
): Promise<ReturnType<TransitService['status']>['realtime']> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = service.realtime;
    const vehiclesDone = !feeds.vehiclePositions || state.lastVehicleUpdate !== null;
    const tripsDone = !feeds.tripUpdates || state.lastTripUpdate !== null;
    const alertsDone = !feeds.alerts || state.lastAlertUpdate !== null;
    if ((vehiclesDone && tripsDone && alertsDone) || state.lastError || Date.now() > deadline) {
      return service.status().realtime;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

main().catch((err: unknown) => {
  log.error('verify: FAILED', err);
  process.exit(1);
});
