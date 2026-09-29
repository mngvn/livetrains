// One-off fact-finding against the real services this app depends on.
// Runs in CI (which has network access); not part of the app.
import { unzipSync, strFromU8 } from 'fflate';
import bindings from 'gtfs-realtime-bindings';
import { createHash } from 'node:crypto';
const { transit_realtime: rt } = bindings;

const section = (t) => console.log(`\n===== ${t} =====`);
const get = async (url, init) => {
  try {
    return { res: await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) }) };
  } catch (err) {
    return { err: String(err) };
  }
};

section('linked_datasets / vehicles / pathways');
const g = await get('https://svc.metrotransit.org/mtgtfs/gtfs.zip');
const files = unzipSync(new Uint8Array(await g.res.arrayBuffer()));
const text = (name) => (files[name] ? strFromU8(files[name]) : '(absent)');
console.log(text('linked_datasets.txt'));
const head = (name, n) => text(name).split(/\r?\n/).slice(0, n).join('\n');
console.log('--- vehicles.txt ---\n' + head('vehicles.txt', 4));
console.log('--- pathways.txt ---\n' + head('pathways.txt', 4));
console.log('pathways rows:', text('pathways.txt').split(/\r?\n/).filter(Boolean).length - 1);
console.log('--- levels.txt ---\n' + head('levels.txt', 4));
console.log('--- feed_info.txt ---\n' + head('feed_info.txt', 3));

section('realtime URLs, up to three attempts each');
const urls = new Set([
  'https://svc.metrotransit.org/mtgtfs/vehiclepositions.pb',
  'https://svc.metrotransit.org/mtgtfs/tripupdates.pb',
  'https://svc.metrotransit.org/mtgtfs/alerts.pb',
]);
for (const line of text('linked_datasets.txt').split(/\r?\n/).slice(1)) {
  for (const m of line.matchAll(/https?:\/\/[^,"\s]+/g)) urls.add(m[0]);
}
for (const url of urls) {
  for (let i = 0; i < 3; i++) {
    const r = await get(url, { headers: { Origin: 'https://mngvn.github.io' } });
    let extra = '';
    if (r.res?.ok) {
      try {
        const feed = rt.FeedMessage.decode(new Uint8Array(await r.res.arrayBuffer()));
        extra = `entities=${feed.entity.length} vehicles=${feed.entity.filter((e) => e.vehicle).length}`;
        const withAgency = {};
        for (const e of feed.entity) {
          if (!e.vehicle) continue;
          const key = e.vehicle.stopId ? 'stopId' : 'no-stopId';
          withAgency[key] = (withAgency[key] ?? 0) + 1;
        }
        if (Object.keys(withAgency).length) extra += ' ' + JSON.stringify(withAgency);
        const sample = feed.entity.find((e) => e.vehicle)?.vehicle;
        if (sample) extra += ' sample=' + JSON.stringify(sample).slice(0, 300);
      } catch (e) {
        extra = 'not protobuf: ' + e;
      }
    }
    console.log(url, 'try', i + 1, '->', r.res?.status ?? r.err, 'ACAO', r.res?.headers.get('access-control-allow-origin'), extra);
    if (r.res?.ok) break;
    await new Promise((res) => setTimeout(res, 3000));
  }
}

section('Esri: is z20 a placeholder?');
const tile = (z, lat, lon) => {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor(
    ((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * n,
  );
  return { x, y };
};
for (const [name, lat, lon] of [
  ['downtown', 44.9778, -93.265],
  ['uptown', 44.9483, -93.298],
  ['st paul', 44.9537, -93.09],
]) {
  for (const z of [19, 20]) {
    const { x, y } = tile(z, lat, lon);
    const r = await get(`https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`);
    const buf = Buffer.from(await r.res.arrayBuffer());
    console.log(name, `z${z}`, r.res.status, buf.length, createHash('md5').update(buf).digest('hex').slice(0, 10));
  }
}
const meta = await get('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer?f=json');
if (meta.res?.ok) {
  const m = await meta.res.json();
  console.log('service max level:', Math.max(...m.tileInfo.lods.map((l) => l.level)));
}
