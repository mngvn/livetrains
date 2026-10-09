import { describe, expect, it, vi } from 'vitest';
import { planeFeedUrls, planeFetcher } from './planeFeed.ts';

const BBOX: [number, number, number, number] = [-93.6, 44.72, -92.85, 45.18];
const answer = (source: string) =>
  new Response(JSON.stringify({ ac: [{ hex: 'a095aa', lat: 44.9, lon: -93.2, seen_pos: 0 }], now: 1_000_000, source }), {
    status: 200,
  });

describe('planeFeedUrls', () => {
  it('reads one relay, or several separated by spaces or commas', () => {
    expect(planeFeedUrls('https://a.example/planes/{lat}/{lon}/{radius}')).toHaveLength(1);
    expect(planeFeedUrls(' https://a.example/x , https://b.example/y\nhttps://c.example/z ')).toEqual([
      'https://a.example/x',
      'https://b.example/y',
      'https://c.example/z',
    ]);
  });
});

describe('planeFetcher', () => {
  it('moves on to the next relay when one has run out, and stays there', async () => {
    const request = vi.fn(async (url: RequestInfo | URL) =>
      String(url).startsWith('https://a.') ? new Response('quota exceeded', { status: 429 }) : answer('adsb.lol'),
    );
    const fetchPlanes = planeFetcher('https://a.example/planes/{lat}/{lon}/{radius} https://b.example/planes/{lat}/{lon}/{radius}', BBOX, request as typeof fetch);
    const first = await fetchPlanes(new AbortController().signal);
    expect(first.planes).toHaveLength(1);
    expect(request.mock.calls.map((c) => String(c[0]).slice(0, 10))).toEqual(['https://a.', 'https://b.']);
    // Next time, straight to the one that answered.
    await fetchPlanes(new AbortController().signal);
    expect(String(request.mock.calls[2][0])).toMatch(/^https:\/\/b\./);
    expect(String(request.mock.calls[2][0])).toContain('/planes/44.95/-93.225/37');
  });

  it('says why when no relay answers', async () => {
    const request = vi.fn(async () => new Response('', { status: 503 }));
    const fetchPlanes = planeFetcher('https://a.example/x https://b.example/y', BBOX, request as typeof fetch);
    await expect(fetchPlanes(new AbortController().signal)).rejects.toThrow(/503/);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('hands over from a relay that is asleep, and goes back to the first one later', async () => {
    vi.useFakeTimers();
    const request = vi.fn((url: RequestInfo | URL, init?: RequestInit) =>
      String(url).startsWith('https://a.')
        ? new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
        : Promise.resolve(answer('adsb.lol')),
    );
    const fetchPlanes = planeFetcher('https://a.example/x https://b.example/y', BBOX, request as typeof fetch);
    const poll = fetchPlanes(new AbortController().signal);
    await vi.advanceTimersByTimeAsync(7_000);
    expect((await poll).planes).toHaveLength(1);
    // Five minutes on, the first relay gets another chance.
    vi.setSystemTime(Date.now() + 5 * 60_000 + 1);
    const again = fetchPlanes(new AbortController().signal);
    await vi.advanceTimersByTimeAsync(7_000);
    await again;
    expect(request.mock.calls.map((c) => String(c[0])[8])).toEqual(['a', 'b', 'a', 'b']);
    vi.useRealTimers();
  });
});
