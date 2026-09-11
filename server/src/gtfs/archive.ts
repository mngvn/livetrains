import { createWriteStream } from 'node:fs';
import { mkdir, rename, stat, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import yauzl from 'yauzl';
import { log } from '../log.js';

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

  const headers: Record<string, string> = { 'user-agent': 'livetrains/0.1' };
  if (cached) {
    const etag = await readFile(etagPath, 'utf8').catch(() => '');
    if (etag) headers['if-none-match'] = etag.trim();
  }

  log.info(`gtfs: downloading ${url}`);
  const response = await fetch(url, { headers });

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
  const temp = `${destination}.part`;
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(temp));
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
): Promise<Map<string, string>> {
  const want = new Set(wanted);
  const out = new Map<string, string>();

  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('could not open GTFS archive'));

      zip.on('entry', (entry) => {
        const name = entry.fileName.split('/').pop() ?? entry.fileName;
        if (!want.has(name)) return zip.readEntry();

        zip.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) return reject(streamErr ?? new Error(`cannot read ${name}`));
          const chunks: Buffer[] = [];
          stream.on('data', (c: Buffer) => chunks.push(c));
          stream.on('end', () => {
            out.set(name, Buffer.concat(chunks).toString('utf8'));
            zip.readEntry();
          });
          stream.on('error', reject);
        });
      });

      zip.on('end', () => resolve(out));
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

export const GTFS_CACHE_DIR = join(process.cwd(), 'data', 'gtfs');
