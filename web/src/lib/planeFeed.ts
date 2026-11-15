import { fillPlaneUrl, planeArea, readPlanes, type PlanesResponse } from '@shared/planes.ts';
import { getApiBase } from './api.ts';
import type { DataMode } from './dataSource.ts';
import type { PlaneFeed, PlaneListening } from './planeTracker.ts';

/**
 * Where the browser gets aircraft from.
 *
 * The community ADS-B feeds do not send CORS headers, so a page cannot read
 * them directly: something has to relay them. In server mode that is this
 * app's own API server. A static build needs a relay named at build time —
 * `VITE_PLANES_URL`, a URL template with `{lat}`, `{lon}` and `{radius}`, or
 * several separated by spaces to fail over between — such as those in
 * `relay/`.
 */

const OVERRIDE_KEY = 'livetrains.planesUrl';

/**
 * The aircraft feed URL template, or null when there is nowhere to ask.
 *
 * A value stored in the browser wins, like the API address does, so the
 * published page can be pointed at a relay without a rebuild. An empty value,
 * stored or built in, turns planes off.
 */
export function planeFeedTemplate(mode: DataMode): string | null {
  try {
    const stored = window.localStorage.getItem(OVERRIDE_KEY);
    if (stored !== null) return stored.trim() || null;
  } catch {
    // Storage unavailable; fall through to the build's choice.
  }
  const built = import.meta.env.VITE_PLANES_URL;
  if (built !== undefined) return built.trim() || null;
  if (mode === 'server') return `${getApiBase()}/api/planes`;
  return null;
}

/**
 * The relay addresses in a template: one, or several separated by spaces or
 * commas, tried in turn.
 */
export function planeFeedUrls(template: string): string[] {
  return template.split(/[\s,]+/).filter(Boolean);
}

/**
 * Whether an address is one of this project's relays (`relay/`), which can
 * keep a connection open and push. Anything else — the app's own API, some
 * other proxy — is only ever polled, and never sent a parameter it did not
 * ask for.
 */
export function canStream(url: string): boolean {
  try {
    const { pathname, search } = new URL(url, 'http://relative.invalid');
    return search === '' && /\/planes\/-?[\d.]+\/-?[\d.]+\/\d+$/.test(pathname);
  } catch {
    return false;
  }
}

/**
 * The aircraft over an agency's area, from the relays in a template.
 *
 * Given several relays, it keeps to the one that last answered and moves on
 * to the next the moment it fails — out of its free allowance, asleep, or
 * down — so free tiers on different hosts add up rather than each being a
 * single point of failure.
 *
 * `listen` asks a relay to keep the connection open and push the sky as it
 * changes. A host's free allowance is counted in requests, and a map polling
 * every fifteen seconds spends 240 of them an hour; listening spends one. A
 * relay that cannot push (an older deployment, the app's own server) simply
 * answers the once, and the caller goes on polling it.
 */
export function planeFeed(
  template: string,
  bbox: [number, number, number, number],
  request: typeof fetch = (input, init) => fetch(input, init),
): PlaneFeed {
  const area = planeArea(bbox);
  const urls = planeFeedUrls(template).map((t) => fillPlaneUrl(t, area));
  /** Relays that answered a request to listen with a single answer: do not ask again. */
  const pollOnly = new Set<number>();
  let preferred = 0;
  let movedAt = 0;

  /**
   * Asks each relay in turn, starting with the one that last answered.
   * `read` turns a relay's response into the result, and throws to move on.
   */
  async function ask<T>(
    signal: AbortSignal,
    stream: boolean,
    read: (response: Response, index: number, settle: () => void) => Promise<T>,
  ): Promise<T> {
    // Listed first means preferred: after a spell on a fallback, try the
    // first again, in case it has woken up or its allowance has reset.
    if (preferred !== 0 && Date.now() - movedAt > RETRY_FIRST_MS) preferred = 0;
    let lastError: unknown = new Error('No aircraft relay is configured');
    for (let i = 0; i < urls.length; i++) {
      const index = (preferred + i) % urls.length;
      const pushes = stream && !pollOnly.has(index) && canStream(urls[index]);
      const url = pushes ? `${urls[index]}?stream=1` : urls[index];
      // Each relay gets a few seconds, so one that is asleep or stuck hands
      // over to the next rather than holding up the whole poll.
      const attempt = new AbortController();
      const abort = () => attempt.abort();
      signal.addEventListener('abort', abort);
      const timer = urls.length > 1 ? setTimeout(abort, RELAY_TIMEOUT_MS) : undefined;
      try {
        const response = await request(url, { signal: attempt.signal, cache: 'no-store' });
        if (!response.ok) throw new Error(`The aircraft feed answered ${response.status}`);
        return await read(response, index, () => {
          // This relay is the one: stay on it, and stop its clock.
          clearTimeout(timer);
          if (index !== preferred) movedAt = Date.now();
          preferred = index;
        });
      } catch (err) {
        // Giving up altogether is for the tracker to decide.
        if (signal.aborted) throw err;
        lastError = err;
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
      }
    }
    throw lastError;
  }

  const answer = async (response: Response, index: number): Promise<PlanesResponse> => {
    const read = readPlanes(await response.json());
    return { ...read, source: read.source ?? guessSource(urls[index]) };
  };

  return {
    fetch: (signal) =>
      ask(signal, false, async (response, index, settle) => {
        const planes = await answer(response, index);
        settle();
        return planes;
      }),

    listen: (signal, on) =>
      ask(signal, true, async (response, index, settle): Promise<PlaneListening> => {
        if (!(response.headers.get('content-type') ?? '').includes('text/event-stream')) {
          // A relay from before streaming ignores the request to and answers
          // the once. That answer is as good as any poll's.
          pollOnly.add(index);
          const planes = await answer(response, index);
          settle();
          on.planes(planes);
          return 'polled';
        }
        if (!response.body) throw new Error('The aircraft relay sent nothing to listen to');
        let heard = false;
        await readEvents(response.body, signal, (event, data) => {
          if (event === 'message') {
            const read = readPlanes(JSON.parse(data));
            if (!heard) settle();
            heard = true;
            on.planes({ ...read, source: read.source ?? guessSource(urls[index]) });
          } else if (event === 'problem') {
            let message = 'The aircraft feed did not answer';
            try {
              message = String((JSON.parse(data) as { error?: unknown }).error ?? message);
            } catch {
              // Whatever it said, the feed is not answering.
            }
            // A relay that opens with a problem has nothing to give: let
            // the next one try. One that was working keeps its connection,
            // since its feed may answer again on the next beat.
            if (!heard) throw new Error(message);
            on.problem(message);
          }
        });
        if (!heard) throw new Error('The aircraft relay closed without an answer');
        return 'ended';
      }),
  };
}

/** How long one of several relays gets before the next is tried. */
const RELAY_TIMEOUT_MS = 7_000;

/** How long to stay on a fallback before trying the first relay again. */
const RETRY_FIRST_MS = 5 * 60_000;

/**
 * A stream that has sent nothing for this long has stalled: a relay sends
 * every fifteen seconds, so three missed beats is a dead connection that
 * nobody closed.
 */
export const STREAM_QUIET_MS = 50_000;

/**
 * Reads Server-Sent Events off a response until it ends, calling `onEvent`
 * with each event's name ("message" when it has none) and data.
 *
 * Read by hand rather than with `EventSource`, which cannot say what status
 * a relay answered with, cannot be given a timeout, and retries on its own
 * schedule rather than the tracker's.
 */
export async function readEvents(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onEvent: (event: string, data: string) => void,
  quietMs = STREAM_QUIET_MS,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let quiet = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => void reader.cancel().catch(() => undefined);
  const listenForQuiet = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      quiet = true;
      cancel();
    }, quietMs);
  };
  signal.addEventListener('abort', cancel);
  try {
    listenForQuiet();
    for (;;) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw new DOMException('Stopped listening', 'AbortError');
      if (quiet) throw new Error('The aircraft relay went quiet');
      if (done) return;
      listenForQuiet();
      pending += decoder.decode(value, { stream: true });
      // Events end at a blank line; whatever follows the last one is the
      // start of the next, still arriving.
      const blocks = pending.split(/\r?\n\r?\n/);
      pending = blocks.pop() ?? '';
      for (const block of blocks) {
        let event = 'message';
        const data: string[] = [];
        for (const line of block.split(/\r?\n/)) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        }
        if (data.length > 0) onEvent(event, data.join('\n'));
      }
    }
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
    cancel();
  }
}

/** Which network a relayed feed came from, when the relay did not say: for the credit. */
function guessSource(url: string): string | undefined {
  const plain = decodeURIComponent(url);
  if (plain.includes('adsb.lol')) return 'adsb.lol';
  if (plain.includes('adsb.fi')) return 'adsb.fi';
  return undefined;
}
