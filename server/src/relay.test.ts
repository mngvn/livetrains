import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readPlanes } from './shared/planes.js';

// The relay is standalone plain JavaScript, so it can be deployed as one file
// to Cloudflare, Deno or Node; it is tested from here because this is where
// the tests run. It holds recent answers in memory, so each test loads a
// fresh copy.
let relay: { fetch: (request: Request, env?: Record<string, string>, ctx?: unknown) => Promise<Response> };
beforeEach(async () => {
  vi.resetModules();
  relay = (await import('../../relay/planes-worker.js')).default;
});

const ask = (path: string, init: RequestInit & { origin?: string } = {}, env: Record<string, string> = {}) =>
  relay.fetch(
    new Request(`https://relay.example${path}`, {
      ...init,
      headers: { ...(init.origin ? { origin: init.origin } : {}) },
    }),
    env,
    { waitUntil: () => undefined },
  ) as Promise<Response>;

const FEED = {
  ac: [{ hex: 'a095aa', flight: 'EDV5350 ', lat: 44.87, lon: -93.17, alt_baro: 1050, seen_pos: 0.2, rssi: -21, messages: 128093, nic: 8 }],
  now: 1791140619001,
};

describe('the aircraft relay worker', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('relays the feed with CORS headers and names its source', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(FEED), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const response = await ask('/planes/44.9512/-93.2261/37', { origin: 'https://mngvn.github.io' });
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    const body = await response.json();
    expect(body.source).toBe('adsb.lol');
    expect(readPlanes(body).planes[0].callsign).toBe('EDV5350');
    // …and the source survives reading, so the map can credit it.
    expect(readPlanes(body).source).toBe('adsb.lol');
    // The centre is rounded so one city's visitors share an answer.
    expect(String(fetch.mock.calls[0][0])).toBe('https://api.adsb.lol/v2/point/44.95/-93.23/37');
  });

  it('falls back to the second feed when the first is down', async () => {
    const fetch = vi.fn(async (url: string) =>
      url.includes('adsb.lol') ? new Response('', { status: 503 }) : new Response(JSON.stringify(FEED), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetch);
    const body = await (await ask('/planes/44.95/-93.2/37')).json();
    expect(body.source).toBe('adsb.fi');
  });

  it('caps the radius', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(FEED), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    await ask('/planes/44.95/-93.2/900');
    expect(String(fetch.mock.calls[0][0])).toMatch(/\/100$/);
  });

  it('answers nothing else', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect((await ask('/https://example.com/anything')).status).toBe(404);
    expect((await ask('/planes/44.95/-93.2/37', { method: 'POST' })).status).toBe(405);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('answers a preflight', async () => {
    const response = await ask('/planes/44.95/-93.2/37', { method: 'OPTIONS', origin: 'https://mngvn.github.io' });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-methods')).toContain('GET');
  });

  it('can be limited to named sites', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(FEED), { status: 200 })));
    const env = { ALLOWED_ORIGINS: 'https://mngvn.github.io' };
    const ours = await ask('/planes/44.95/-93.2/37', { origin: 'https://mngvn.github.io' }, env);
    expect(ours.headers.get('access-control-allow-origin')).toBe('https://mngvn.github.io');
    expect((await ask('/planes/44.95/-93.2/37', { origin: 'https://elsewhere.example' }, env)).status).toBe(403);
  });

  it('says so when every feed is down', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })));
    const response = await ask('/planes/44.95/-93.2/37');
    expect(response.status).toBe(502);
    expect((await response.json()).error).toMatch(/No aircraft feed answered/);
  });
});

describe('what the relay passes on', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('keeps only the fields the map reads', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(FEED), { status: 200 })));
    const body = await (await ask('/planes/44.95/-93.2/37')).json();
    expect(body.ac[0]).toEqual({ hex: 'a095aa', flight: 'EDV5350 ', lat: 44.87, lon: -93.17, alt_baro: 1050, seen_pos: 0.2 });
  });

  it('answers a crowd from one fetch, with the clock moved on by how long it was held', async () => {
    vi.useFakeTimers({ now: 1_791_140_619_000, toFake: ['Date'] });
    const fetch = vi.fn(async () => new Response(JSON.stringify(FEED), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    await ask('/planes/44.95/-93.2/37');
    vi.setSystemTime(1_791_140_622_000);
    const second = await (await ask('/planes/44.95/-93.2/37')).json();
    expect(fetch).toHaveBeenCalledTimes(1);
    // adsb.lol keeps time in milliseconds: three seconds on.
    expect(second.now).toBe(FEED.now + 3000);
    // Past the five seconds, it asks again.
    vi.setSystemTime(1_791_140_625_500);
    await ask('/planes/44.95/-93.2/37');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('the relay as a stream', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /** Reads what a stream has sent so far, as events. */
  async function events(reader: ReadableStreamDefaultReader<Uint8Array>, count: number) {
    const decoder = new TextDecoder();
    const found: { event: string; data: any }[] = [];
    let text = '';
    while (found.length < count) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      const blocks = text.split('\n\n');
      text = blocks.pop() ?? '';
      for (const block of blocks) {
        const data = /^data: (.*)$/m.exec(block);
        if (data) found.push({ event: /^event: (.*)$/m.exec(block)?.[1] ?? 'message', data: JSON.parse(data[1]) });
      }
    }
    return found;
  }

  it('sends the sky at once, then again every fifteen seconds, for one request', async () => {
    vi.useFakeTimers({ now: 1_791_140_610_000 });
    const fetch = vi.fn(async () => new Response(JSON.stringify(FEED), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const response = await ask('/planes/44.95/-93.2/37?stream=1', { origin: 'https://mngvn.github.io' });
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    const reader = response.body!.getReader();
    const [first] = await events(reader, 1);
    expect(readPlanes(first.data).planes[0].callsign).toBe('EDV5350');
    expect(first.data.source).toBe('adsb.lol');
    await vi.advanceTimersByTimeAsync(45_000);
    expect(await events(reader, 3)).toHaveLength(3);
    expect(fetch).toHaveBeenCalledTimes(4);
    // The page going away stops the relay asking the feed.
    await reader.cancel();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('serves every listener from one request to the feed each beat', async () => {
    vi.useFakeTimers({ now: 1_791_140_610_000 });
    const fetch = vi.fn(async () => new Response(JSON.stringify(FEED), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const readers = [];
    for (let i = 0; i < 5; i++) {
      readers.push((await ask('/planes/44.95/-93.2/37?stream=1')).body!.getReader());
      // People arrive when they arrive, not on the beat.
      await vi.advanceTimersByTimeAsync(700);
    }
    await vi.advanceTimersByTimeAsync(60_000);
    for (const reader of readers) expect((await events(reader, 4)).length).toBe(4);
    // One at the start, shared while fresh, then one a beat: not five a beat.
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(6);
    await Promise.all(readers.map((reader) => reader.cancel()));
  });

  it('says when the feeds are down, and carries on', async () => {
    vi.useFakeTimers({ now: 1_791_140_610_000 });
    let up = false;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(up ? JSON.stringify(FEED) : '', { status: up ? 200 : 503 })));
    const reader = (await ask('/planes/44.95/-93.2/37?stream=1')).body!.getReader();
    const [problem] = await events(reader, 1);
    expect(problem.event).toBe('problem');
    expect(problem.data.error).toMatch(/No aircraft feed answered/);
    up = true;
    await vi.advanceTimersByTimeAsync(15_000);
    const [next] = await events(reader, 1);
    expect(next.event).toBe('message');
    await reader.cancel();
  });

  it('ends a stream after half an hour, so the page opens a fresh one', async () => {
    vi.useFakeTimers({ now: 1_791_140_610_000 });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(FEED), { status: 200 })));
    const reader = (await ask('/planes/44.95/-93.2/37?stream=1')).body!.getReader();
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    const all = await events(reader, 1000);
    expect(all[all.length - 1].event).toBe('bye');
    expect(all.length).toBeGreaterThan(100);
  });

  it('keeps to the feed that works rather than waiting on the one that does not', async () => {
    const fetch = vi.fn(async (url: string) =>
      url.includes('adsb.lol') ? new Response('', { status: 503 }) : new Response(JSON.stringify(FEED), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetch);
    await ask('/planes/44.95/-93.2/37');
    await ask('/planes/41.88/-87.63/37');
    expect(fetch.mock.calls.map((c) => (String(c[0]).includes('adsb.lol') ? 'lol' : 'fi'))).toEqual(['lol', 'fi', 'fi']);
  });

  it('is under the same origin rule as a poll', async () => {
    const env = { ALLOWED_ORIGINS: 'https://mngvn.github.io' };
    expect((await ask('/planes/44.95/-93.2/37?stream=1', { origin: 'https://elsewhere.example' }, env)).status).toBe(403);
  });
});
