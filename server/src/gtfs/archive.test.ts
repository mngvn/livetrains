import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readZipEntries } from './archive.js';

let dir: string;
let zipPath: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'livetrains-archive-'));
  zipPath = join(dir, 'feed.zip');
  await writeFile(
    zipPath,
    zipSync({
      // Some agencies nest the feed in a folder; the folder is ignored.
      'feed/stops.txt': strToU8('stop_id,stop_name\nA,Alpha\n'),
      'feed/routes.txt': strToU8('route_id\nR\n'),
      'readme.txt': strToU8('not part of GTFS'),
    }),
  );
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('readZipEntries', () => {
  it('reads the wanted files, whatever folder they sit in, and nothing else', async () => {
    const files = await readZipEntries(zipPath, ['stops.txt', 'routes.txt', 'trips.txt']);
    expect([...files.keys()].sort()).toEqual(['routes.txt', 'stops.txt']);
    expect(files.get('stops.txt')).toContain('Alpha');
  });

  it('refuses a file bigger than the limit before inflating it', async () => {
    await expect(readZipEntries(zipPath, ['stops.txt'], { fileBytes: 8, totalBytes: 1_000 })).rejects.toThrow(
      /too large/,
    );
  });

  it('refuses an archive whose wanted files together pass the total limit', async () => {
    await expect(
      readZipEntries(zipPath, ['stops.txt', 'routes.txt'], { fileBytes: 1_000, totalBytes: 30 }),
    ).rejects.toThrow(/too large/);
  });
});
