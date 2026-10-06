import { afterEach, describe, expect, it, vi } from 'vitest';
import { WalkRouter } from './walkRouter.ts';

/** A Valhalla answer for a two-point walk. */
const ROUTE = {
  trip: {
    // "_p~iF~ps|U_ulLnnqC" is the classic Google example; any valid shape will do.
    legs: [{ shape: '_p~iF~ps|U_ulLnnqC' }],
    summary: { length: 0.4, time: 300 },
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('WalkRouter cache', () => {
  it('asks once per walk, however many plans repeat it', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(ROUTE)));
    vi.stubGlobal('fetch', fetchMock);
    const router = new WalkRouter('https://router.invalid/route');
    const a = { lat: 44.97, lon: -93.26 };
    const b = { lat: 44.98, lon: -93.27 };
    await router.route(a, b, 500);
    await router.route(a, b, 500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps a bounded number of walks, dropping the least recently used', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(ROUTE))));
    const router = new WalkRouter('https://router.invalid/route');
    for (let i = 0; i < 400; i++) {
      await router.route({ lat: 44 + i / 1000, lon: -93 }, { lat: 45, lon: -93 }, 500);
    }
    expect(router.cached).toBeLessThanOrEqual(300);
  });

  it('asks again a while after a failure, not on every plan and not never', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const fetchMock = vi.fn(async () => new Response('busy', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    const router = new WalkRouter('https://router.invalid/route');
    const a = { lat: 44.97, lon: -93.26 };
    const b = { lat: 44.98, lon: -93.27 };
    expect(await router.route(a, b, 500)).toBeNull();
    expect(await router.route(a, b, 500)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 6 * 60_000);
    await router.route(a, b, 500);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
