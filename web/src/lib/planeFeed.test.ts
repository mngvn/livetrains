import { describe, expect, it, vi } from 'vitest';
import { canStream, planeFeed, planeFeedUrls, readEvents } from './planeFeed.ts';

const planeFetcher = (...args: Parameters<typeof planeFeed>) => planeFeed(...args).fetch;

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

/** A response whose body is fed by hand, as a relay's stream would be. */
function streamed() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
  const encoder = new TextEncoder();
  return {
    response: new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    send: (text: string) => controller.enqueue(encoder.encode(text)),
    end: () => controller.close(),
    drop: () => controller.error(new Error('connection lost')),
  };
}
const sky = (source = 'adsb.lol') =>
  `data: ${JSON.stringify({ ac: [{ hex: 'a095aa', lat: 44.9, lon: -93.2, seen_pos: 0 }], now: 1_000_000, source })}\n\n`;
const RELAY = 'https://a.example/planes/{lat}/{lon}/{radius}';
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('canStream', () => {
  it("is true of this project's relays and nothing else", () => {
    expect(canStream('https://a.example/planes/44.95/-93.225/37')).toBe(true);
    expect(canStream('https://a.example/some/prefix/planes/-33.9/151.2/40')).toBe(true);
    expect(canStream('/api/planes')).toBe(false);
    expect(canStream('https://proxy.example/?url=https%3A%2F%2Fapi.adsb.lol%2Fv2%2Fpoint%2F44.95%2F-93.2%2F37')).toBe(false);
  });
});

describe('listening to a relay', () => {
  it('takes every sky the relay pushes over one request', async () => {
    const relay = streamed();
    const request = vi.fn(async (_url: RequestInfo | URL) => relay.response);
    const planes = vi.fn();
    const listening = planeFeed(RELAY, BBOX, request as typeof fetch).listen!(new AbortController().signal, {
      planes,
      problem: vi.fn(),
    });
    relay.send('retry: 2000\n\n');
    relay.send(sky());
    // An event can arrive in pieces.
    const second = sky('adsb.fi');
    relay.send(second.slice(0, 40));
    relay.send(second.slice(40));
    relay.send('event: bye\ndata: {}\n\n');
    relay.end();
    expect(await listening).toBe('ended');
    expect(planes.mock.calls.map((c) => c[0].source)).toEqual(['adsb.lol', 'adsb.fi']);
    expect(request).toHaveBeenCalledTimes(1);
    expect(String(request.mock.calls[0][0])).toBe('https://a.example/planes/44.95/-93.225/37?stream=1');
  });

  it('polls a relay from before streaming, without asking it to stream again', async () => {
    const request = vi.fn(async (_url: RequestInfo | URL) => answer('adsb.lol'));
    const feed = planeFeed(RELAY, BBOX, request as typeof fetch);
    const planes = vi.fn();
    expect(await feed.listen!(new AbortController().signal, { planes, problem: vi.fn() })).toBe('polled');
    expect(planes).toHaveBeenCalledTimes(1);
    await feed.listen!(new AbortController().signal, { planes, problem: vi.fn() });
    expect(request.mock.calls.map((c) => String(c[0]).includes('stream'))).toEqual([true, false]);
  });

  it("only ever polls the app's own server", async () => {
    const request = vi.fn(async (_url: RequestInfo | URL) => answer('adsb.lol'));
    const feed = planeFeed('/api/planes', BBOX, request as typeof fetch);
    expect(await feed.listen!(new AbortController().signal, { planes: vi.fn(), problem: vi.fn() })).toBe('polled');
    expect(String(request.mock.calls[0][0])).toBe('/api/planes');
  });

  it('moves on to the next relay when one cannot be listened to', async () => {
    const relay = streamed();
    const request = vi.fn(async (url: RequestInfo | URL) =>
      String(url).startsWith('https://a.') ? new Response('quota exceeded', { status: 429 }) : relay.response,
    );
    const planes = vi.fn();
    const listening = planeFeed(`${RELAY} https://b.example/planes/{lat}/{lon}/{radius}`, BBOX, request as typeof fetch).listen!(
      new AbortController().signal,
      { planes, problem: vi.fn() },
    );
    await settle();
    relay.send(sky());
    relay.end();
    expect(await listening).toBe('ended');
    expect(planes).toHaveBeenCalledTimes(1);
  });

  it('passes on a problem from a relay that was working, and keeps listening', async () => {
    const relay = streamed();
    const planes = vi.fn();
    const problem = vi.fn();
    const listening = planeFeed(RELAY, BBOX, (async () => relay.response) as typeof fetch).listen!(
      new AbortController().signal,
      { planes, problem },
    );
    relay.send(sky());
    relay.send('event: problem\ndata: {"error":"No aircraft feed answered: adsb.lol answered 429"}\n\n');
    relay.send(sky());
    relay.end();
    await listening;
    expect(problem).toHaveBeenCalledWith('No aircraft feed answered: adsb.lol answered 429');
    expect(planes).toHaveBeenCalledTimes(2);
  });

  it('fails when the stream drops, or opens with nothing to give', async () => {
    const dropped = streamed();
    const listening = planeFeed(RELAY, BBOX, (async () => dropped.response) as typeof fetch).listen!(
      new AbortController().signal,
      { planes: vi.fn(), problem: vi.fn() },
    );
    dropped.send(sky());
    await settle();
    dropped.drop();
    await expect(listening).rejects.toThrow(/connection lost/);

    const empty = streamed();
    const nothing = planeFeed(RELAY, BBOX, (async () => empty.response) as typeof fetch).listen!(
      new AbortController().signal,
      { planes: vi.fn(), problem: vi.fn() },
    );
    empty.send('event: problem\ndata: {"error":"No aircraft feed answered"}\n\n');
    await expect(nothing).rejects.toThrow(/No aircraft feed answered/);
  });
});

describe('readEvents', () => {
  it('gives up on a stream that has gone quiet', async () => {
    vi.useFakeTimers();
    const relay = streamed();
    const reading = readEvents(relay.response.body!, new AbortController().signal, vi.fn(), 50_000);
    const failed = expect(reading).rejects.toThrow(/went quiet/);
    relay.send(sky());
    await vi.advanceTimersByTimeAsync(49_000);
    relay.send(': still here\n\n');
    await vi.advanceTimersByTimeAsync(49_000);
    await vi.advanceTimersByTimeAsync(2_000);
    await failed;
    vi.useRealTimers();
  });

  it('stops when told to', async () => {
    const relay = streamed();
    const controller = new AbortController();
    const reading = readEvents(relay.response.body!, controller.signal, vi.fn());
    controller.abort();
    await expect(reading).rejects.toThrow(/Stopped listening/);
  });
});
