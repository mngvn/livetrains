import { createWriteStream } from 'node:fs';
import { mkdir, rename, stat, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import yauzl from 'yauzl';
import { log } from '../log.js';
import { MAX_GTFS_FILE_BYTES, MAX_GTFS_TOTAL_BYTES } from './store.js';

/**
 * How long a download may take before it is abandoned, start to finish. A
 * stalled transfer would otherwise hold startup forever; ten minutes is
 * generous for a 20–60MB archive on any working connection.
 */
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

/** No published timetable archive comes near this; anything bigger is refused. */
const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;

/**
 * Downloads a GTFS zip to `destination`, reusing the cached copy when the
 * server already has a recent one.
 *
 * Static GTFS changes a few times a year at most, so re-downloading ~60MB on
 * every boot is pure waste. We keep an ETag alongside the archive and send a
 * conditional request; a 304 means the cached file is still current.
 */
export async function downloadGtfs(
  url: string,
  destination: string,
  maxAgeMs: number,
): Promise<{ path: string; fromCache: boolean }> {
  await mkdir(dirname(destination), { recursive: true });
  const etagPath = `${destination}.etag`;

  const cached = await stat(destination).catch(() => null);
  const fresh = cached !== null && Date.now() - cached.mtimeMs < maxAgeMs;
  if (fresh) {
    log.info(`gtfs: using cached archive (${(cached.size / 1e6).toFixed(1)} MB)`);
    return { path: destination, fromCache: true };
  }

  const headers: Record<string, string> = { 'user-agent': 'livetrains/0.1 (+https://github.com/mngvn/livetrains)' };
  if (cached) {
    const etag = await readFile(etagPath, 'utf8').catch(() => '');
    if (etag) headers['if-none-match'] = etag.trim();
  }

  log.info(`gtfs: downloading ${url}`);
  const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, { headers, signal });
  } catch (err) {
    // Offline or unreachable: a cached archive, however stale, still boots.
    if (cached) {
      log.warn(`gtfs: download failed (${err instanceof Error ? err.message : String(err)}), falling back to cache`);
      return { path: destination, fromCache: true };
    }
    throw err;
  }

  if (response.status === 304 && cached) {
    log.info('gtfs: remote archive unchanged, keeping cached copy');
    return { path: destination, fromCache: true };
  }
  if (!response.ok || !response.body) {
    // A cached archive, however stale, beats booting with no schedule at all.
    if (cached) {
      log.warn(`gtfs: download failed (HTTP ${response.status}), falling back to cache`);
      return { path: destination, fromCache: true };
    }
    throw new Error(`GTFS download failed: HTTP ${response.status} from ${url}`);
  }

  // Write to a temp path first so a failed transfer can never leave a
  // truncated archive that looks valid on the next boot.
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_ARCHIVE_BYTES) {
    throw new Error(`GTFS archive is ${(declared / 1e6).toFixed(0)} MB, more than this server will download`);
  }
  const temp = `${destination}.part`;
  let received = 0;
  await pipeline(
    Readable.fromWeb(response.body as never),
    // Counted as it arrives, since a length header is only a claim.
    async function* (source: AsyncIterable<Buffer>) {
      for await (const chunk of source) {
        received += chunk.length;
        if (received > MAX_ARCHIVE_BYTES) throw new Error('GTFS archive is larger than this server will download');
        yield chunk;
      }
    },
    createWriteStream(temp),
  );
  await rename(temp, destination);

  const etag = response.headers.get('etag');
  if (etag) await writeFile(etagPath, etag, 'utf8');

  const size = (await stat(destination)).size;
  log.info(`gtfs: downloaded ${(size / 1e6).toFixed(1)} MB`);
  return { path: destination, fromCache: false };
}

/**
 * Reads the named entries out of a GTFS zip.
 *
 * Returns a map of file name to file contents. Entries the archive does not
 * contain are simply absent — several GTFS files are optional, and callers
 * decide what is required. Directory prefixes are ignored, since some agencies
 * nest the feed inside a folder within the zip.
 */
export function readZipEntries(
  zipPath: string,
  wanted: readonly string[],
  limits: { fileBytes: number; totalBytes: number } = { fileBytes: MAX_GTFS_FILE_BYTES, totalBytes: MAX_GTFS_TOTAL_BYTES },
): Promise<Map<string, string>> {
  const want = new Set(wanted);
  const out = new Map<string, string>();

  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true, validateEntrySizes: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('could not open GTFS archive'));

      // Close the file on any failure; autoClose only covers reaching the end.
      const fail = (error: Error) => {
        zip.close();
        reject(error);
      };
      let total = 0;

      zip.on('entry', (entry) => {
        const name = entry.fileName.split('/').pop() ?? entry.fileName;
        if (!want.has(name)) return zip.readEntry();

        // Sizes are checked as declared, before inflating anything; yauzl
        // then holds the stream to the declared size, so it cannot lie.
        total += entry.uncompressedSize;
        if (entry.uncompressedSize > limits.fileBytes || total > limits.totalBytes) {
          return fail(
            new Error(`GTFS archive's ${name} is too large to load (${(entry.uncompressedSize / 1e6).toFixed(0)} MB unpacked)`),
          );
        }

        zip.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) return fail(streamErr ?? new Error(`cannot read ${name}`));
          const chunks: Buffer[] = [];
          stream.on('data', (c: Buffer) => chunks.push(c));
          stream.on('end', () => {
            out.set(name, Buffer.concat(chunks).toString('utf8'));
            zip.readEntry();
          });
          stream.on('error', fail);
        });
      });

      zip.on('end', () => resolve(out));
      zip.on('error', fail);
      zip.readEntry();
    });
  });
}

export const GTFS_CACHE_DIR = join(process.cwd(), 'data', 'gtfs');
