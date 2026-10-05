import { afterEach, describe, expect, it, vi } from 'vitest';
// The relay is a standalone Cloudflare Worker, plain JavaScript so it can be
// deployed as one file; it is tested from here because this is where the
// tests run.
import relay from '../../relay/planes-worker.js';
import { readPlanes } from './shared/planes.js';

const ask = (path: string, init: RequestInit & { origin?: string } = {}, env: Record<string, string> = {}) =>
  relay.fetch(
    new Request(`https://relay.example${path}`, {
      ...init,
      headers: { ...(init.origin ? { origin: init.origin } : {}) },
    }),
    env,
    { waitUntil: () => undefined },
  ) as Promise<Response>;

const FEED = { ac: [{ hex: 'a095aa', flight: 'EDV5350 ', lat: 44.87, lon: -93.17, alt_baro: 1050, seen_pos: 0.2 }], now: 1791140619001 };

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
