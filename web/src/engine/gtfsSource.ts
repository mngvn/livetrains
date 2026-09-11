import { unzipSync, strFromU8 } from 'fflate';
import type { AgencyDefinition } from '../../../server/src/agencies/types.js';
import { GTFS_FILES } from '../../../server/src/gtfs/store.js';

/**
 * Fetches and unpacks an agency's static GTFS archive in the browser.
 *
 * Metro Transit serves every feed with `Access-Control-Allow-Origin: *`, so the
 * browser can read them directly and the app needs no server of its own. The
 * archive is the one heavy piece — about 19MB compressed, 60MB unpacked — so
 * this reports progress while it downloads and caches the bytes afterwards.
 */

/** Where the raw archive is kept between visits. */
const CACHE_NAME = 'livetrains-gtfs-v1';
/** Header stamped onto the cached response so staleness can be judged. */
const CACHED_AT_HEADER = 'x-livetrains-cached-at';

export interface LoadProgress {
  phase: 'downloading' | 'unpacking' | 'parsing' | 'indexing' | 'ready';
  /** Bytes received so far, when downloading. */
  loaded?: number;
  /** Total bytes, when the server declares a length. */
  total?: number;
  detail?: string;
}

export type ProgressListener = (progress: LoadProgress) => void;

/**
 * Reads the archive, from cache when it is fresh enough.
 *
 * GTFS timetables change a few times a year, so a day-old copy is still
 * correct; re-downloading 19MB on every page load would not be.
 */
async function fetchArchive(
  url: string,
  maxAgeMs: number,
  onProgress: ProgressListener,
): Promise<Uint8Array> {
  const cache = await openCache();

  if (cache) {
    const cached = await cache.match(url).catch(() => undefined);
    if (cached) {
      const cachedAt = Number(cached.headers.get(CACHED_AT_HEADER) ?? 0);
      if (Date.now() - cachedAt < maxAgeMs) {
        onProgress({ phase: 'downloading', detail: 'Using the saved timetable' });
        return new Uint8Array(await cached.arrayBuffer());
      }
    }
  }

  let response: Response;
  try {
    response = await fetch(url, { mode: 'cors' });
  } catch (err) {
    // Offline or blocked: a stale cached copy beats no app at all.
    const stale = cache ? await cache.match(url).catch(() => undefined) : undefined;
    if (stale) {
      onProgress({ phase: 'downloading', detail: 'Offline — using the saved timetable' });
      return new Uint8Array(await stale.arrayBuffer());
    }
    throw new Error(
      `Could not download the timetable from ${new URL(url).host}. ` +
        `Check your connection: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!response.ok) {
    throw new Error(`The timetable server returned HTTP ${response.status}`);
  }

  const total = Number(response.headers.get('content-length')) || undefined;
  const bytes = await readWithProgress(response, total, onProgress);

  if (cache) {
    // Store with our own timestamp header so freshness does not depend on
    // whatever caching headers the agency happens to send.
    const headers = new Headers();
    headers.set('content-type', 'application/zip');
    headers.set(CACHED_AT_HEADER, String(Date.now()));
    await cache
      .put(url, new Response(bytes.slice().buffer as ArrayBuffer, { headers }))
      .catch(() => undefined); // a full quota must not break loading
  }

  return bytes;
}

/** Streams a response body, reporting bytes as they arrive. */
async function readWithProgress(
  response: Response,
  total: number | undefined,
  onProgress: ProgressListener,
): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array(await response.arrayBuffer());

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  let lastReport = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    // Reporting every chunk would flood the message channel; every 250KB is
    // frequent enough for a progress bar to look continuous.
    if (loaded - lastReport > 250_000) {
      lastReport = loaded;
      onProgress({ phase: 'downloading', loaded, total });
    }
  }

  onProgress({ phase: 'downloading', loaded, total });

  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** The Cache API is unavailable in some private-browsing modes. */
async function openCache(): Promise<Cache | null> {
  try {
    if (typeof caches === 'undefined') return null;
    return await caches.open(CACHE_NAME);
  } catch {
    return null;
  }
}

/** Discards the cached archive, forcing a fresh download next time. */
export async function clearGtfsCache(): Promise<void> {
  try {
    if (typeof caches !== 'undefined') await caches.delete(CACHE_NAME);
  } catch {
    // Nothing useful to do.
  }
}

/**
 * Downloads and unpacks an agency's GTFS into the file map the parser expects.
 *
 * Only the files the app actually reads are decompressed. That matters here:
 * `shapes.txt` alone is 15MB of the 60MB, and skipping the files we never touch
 * keeps both time and peak memory down on a phone.
 */
export async function loadGtfsFiles(
  agency: AgencyDefinition,
  onProgress: ProgressListener,
  maxAgeMs = 24 * 3600 * 1000,
): Promise<Map<string, string>> {
  const archive = await fetchArchive(agency.gtfsUrl, maxAgeMs, onProgress);

  onProgress({ phase: 'unpacking', detail: 'Unpacking the timetable' });

  const wanted = new Set<string>(GTFS_FILES);
  const unpacked = unzipSync(archive, {
    // fflate calls this per entry; returning true skips the entry entirely.
    filter: (file) => {
      const name = file.name.split('/').pop() ?? file.name;
      return wanted.has(name);
    },
  });

  const files = new Map<string, string>();
  for (const path of Object.keys(unpacked)) {
    const name = path.split('/').pop() ?? path;
    const contents = unpacked[path];
    if (!wanted.has(name) || contents.length === 0) continue;
    files.set(name, strFromU8(contents));
    // Release the decompressed bytes now that they are a string; holding both
    // doubles peak memory during load, which is what constrains phones.
    delete unpacked[path];
  }

  if (files.size === 0) {
    throw new Error('The downloaded archive contained no recognisable GTFS files');
  }
  return files;
}
