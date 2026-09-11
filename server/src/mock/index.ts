import { GtfsStore } from '../gtfs/store.js';
import { buildMockGtfs } from './feed.js';
import { MockSimulator } from './simulator.js';

export { buildMockGtfs } from './feed.js';
export { MockSimulator } from './simulator.js';

/** Loads the synthetic feed into a store, ready to serve or test against. */
export function createMockStore(timezone = 'America/Chicago', now = Date.now()): GtfsStore {
  return GtfsStore.load(buildMockGtfs(timezone, now));
}

/** A store plus a simulator wired to it. */
export function createMockSystem(timezone = 'America/Chicago', now = Date.now()): {
  store: GtfsStore;
  simulator: MockSimulator;
} {
  const store = createMockStore(timezone, now);
  return { store, simulator: new MockSimulator(store) };
}
