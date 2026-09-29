// One-off fact-finding against the real services this app depends on.
// Runs in CI (which has network access); not part of the app.
import { unzipSync, strFromU8 } from 'fflate';
import bindings from 'gtfs-realtime-bindings';
const { transit_realtime: rt } = bindings;

const section = (t) => console.log(`\n===== ${t} =====`);
const get = async (url, init) => {
  const started = Date.now();
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
    return { res, ms: Date.now() - started };
  } catch (err) {
    return { err: String(err), ms: Date.now() - started };
  }
};
const csvRows = (text) => {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
  const split = (l) => { const out = []; let cur = '', q = false;
    for (const ch of l) { if (ch === '"') q = !q; else if (ch === ',' && !q) { out.push(cur); cur = ''; } else cur += ch; }
    out.push(cur); return out; };
  const head = split(lines[0]);
  return lines.slice(1).map((l) => Object.fromEntries(split(l).map((v, i) => [head[i], v])));
};

section('GTFS static');
const g = await get('https://svc.metrotransit.org/mtgtfs/gtfs.zip');
let routes = [], stops = [], trips = [];
if (g.res?.ok) {
  const files = unzipSync(new Uint8Array(await g.res.arrayBuffer()));
  console.log('files:', Object.keys(files).join(', '));
  const agency = csvRows(strFromU8(files['agency.txt']));
  console.log('agency.txt columns:', Object.keys(agency[0] ?? {}).join(','));
  for (const a of agency) console.log('  agency:', JSON.stringify(a));
  routes = csvRows(strFromU8(files['routes.txt']));
  console.log('routes.txt columns:', Object.keys(routes[0] ?? {}).join(','));
  const byAgency = {};
  for (const r of routes) byAgency[r.agency_id ?? '(none)'] = (byAgency[r.agency_id ?? '(none)'] ?? 0) + 1;
  console.log('routes per agency_id:', JSON.stringify(byAgency));
  stops = csvRows(strFromU8(files['stops.txt']));
  console.log('stops.txt columns:', Object.keys(stops[0] ?? {}).join(','));
  const wb = {};
  for (const s of stops) wb[s.wheelchair_boarding ?? '(absent)'] = (wb[s.wheelchair_boarding ?? '(absent)'] ?? 0) + 1;
  console.log('wheelchair_boarding distribution:', JSON.stringify(wb));
  const tripsText = strFromU8(files['trips.txt']);
  const tripHead = tripsText.slice(0, tripsText.indexOf('\n'));
  console.log('trips.txt columns:', tripHead);
  if (files['transfers.txt']) {
    const tr = csvRows(strFromU8(files['transfers.txt']));
    const types = {};
    for (const t of tr) types[t.transfer_type ?? '?'] = (types[t.transfer_type ?? '?'] ?? 0) + 1;
    console.log(`transfers.txt: ${tr.length} rows, columns ${Object.keys(tr[0] ?? {}).join(',')}, types ${JSON.stringify(types)}`);
  } else console.log('transfers.txt: ABSENT');
  if (files['pathways.txt']) console.log('pathways.txt present');
} else console.log('gtfs fetch failed', g.err ?? g.res?.status);

section('Vehicle positions');
const v = await get('https://svc.metrotransit.org/mtgtfs/vehiclepositions.pb');
if (v.res?.ok) {
  const feed = rt.FeedMessage.decode(new Uint8Array(await v.res.arrayBuffer()));
  const ents = feed.entity.filter((e) => e.vehicle);
  const routeIds = new Set(routes.map((r) => r.route_id));
  const agencyOf = Object.fromEntries(routes.map((r) => [r.route_id, r.agency_id]));
  const perAgency = {}; let unknownRoute = 0, withStop = 0, withStatus = 0, withOcc = 0, withBearing = 0;
  for (const e of ents) {
    const rid = e.vehicle.trip?.routeId;
    if (rid && !routeIds.has(rid)) unknownRoute++;
    const a = agencyOf[rid] ?? '(unmatched)';
    perAgency[a] = (perAgency[a] ?? 0) + 1;
    if (e.vehicle.stopId) withStop++;
    if (e.vehicle.currentStatus !== null && e.vehicle.currentStatus !== undefined) withStatus++;
    if (e.vehicle.occupancyStatus) withOcc++;
    if (e.vehicle.position?.bearing) withBearing++;
  }
  console.log(`${ents.length} vehicles; per agency_id ${JSON.stringify(perAgency)}; unknown route ${unknownRoute}`);
  console.log(`with stopId ${withStop}, with currentStatus ${withStatus}, with occupancy ${withOcc}, with bearing ${withBearing}`);
  console.log('sample vehicle:', JSON.stringify(ents[0]?.vehicle));
} else console.log('vehicles fetch failed', v.err ?? v.res?.status);

section('Trip updates');
const t = await get('https://svc.metrotransit.org/mtgtfs/tripupdates.pb');
if (t.res?.ok) {
  const feed = rt.FeedMessage.decode(new Uint8Array(await t.res.arrayBuffer()));
  const ups = feed.entity.filter((e) => e.tripUpdate);
  let stus = 0, withTime = 0, withDelay = 0, both = 0, tripDelay = 0;
  for (const e of ups) {
    if (e.tripUpdate.delay) tripDelay++;
    for (const s of e.tripUpdate.stopTimeUpdate ?? []) {
      stus++;
      const hasT = !!(s.arrival?.time || s.departure?.time);
      const hasD = s.arrival?.delay != null || s.departure?.delay != null;
      if (hasT) withTime++; if (hasD) withDelay++; if (hasT && hasD) both++;
    }
  }
  console.log(`${ups.length} trip updates, ${stus} stop time updates; with absolute time ${withTime}, with delay ${withDelay}, both ${both}; trip-level delay ${tripDelay}`);
  console.log('sample:', JSON.stringify(ups[0]?.tripUpdate).slice(0, 600));
} else console.log('tripupdates fetch failed', t.err ?? t.res?.status);

section('Alerts');
const al = await get('https://svc.metrotransit.org/mtgtfs/alerts.pb');
if (al.res?.ok) {
  const feed = rt.FeedMessage.decode(new Uint8Array(await al.res.arrayBuffer()));
  const alerts = feed.entity.filter((e) => e.alert);
  console.log(`${alerts.length} alerts`);
  for (const a of alerts.slice(0, 4)) {
    const ie = (a.alert.informedEntity ?? []).map((x) => ({ agency: x.agencyId, route: x.routeId, stop: x.stopId, trip: x.trip?.tripId })).slice(0, 4);
    console.log(' -', a.alert.headerText?.translation?.[0]?.text?.slice(0, 90), '| cause', a.alert.cause, '| effect', a.alert.effect, '| entities', JSON.stringify(ie));
  }
} else console.log('alerts fetch failed', al.err ?? al.res?.status);

section('Valhalla (FOSSGIS) pedestrian routing');
const q = { locations: [{ lat: 44.9817, lon: -93.2777, type: 'break' }, { lat: 44.9795, lon: -93.2733, type: 'break' }], costing: 'pedestrian', directions_type: 'none', units: 'kilometers' };
const vh = await get(`https://valhalla1.openstreetmap.de/route?json=${encodeURIComponent(JSON.stringify(q))}`, { headers: { Origin: 'https://mngvn.github.io' } });
if (vh.res) {
  console.log('status', vh.res.status, 'in', vh.ms, 'ms; ACAO:', vh.res.headers.get('access-control-allow-origin'));
  const body = await vh.res.text();
  console.log('body head:', body.slice(0, 300));
} else console.log('valhalla failed', vh.err);

section('OpenFreeMap fonts + tiles');
for (const font of ['Noto Sans Regular', 'Noto Sans Bold', 'Open Sans Regular']) {
  const f = await get(`https://tiles.openfreemap.org/fonts/${encodeURIComponent(font)}/0-255.pbf`);
  console.log(`font "${font}":`, f.res?.status ?? f.err);
}
const tj = await get('https://tiles.openfreemap.org/planet');
if (tj.res?.ok) {
  const json = await tj.res.json();
  console.log('planet tilejson ok; tiles:', JSON.stringify(json.tiles).slice(0, 120), '; vector_layers:', (json.vector_layers ?? []).map((l) => l.id).join(','));
} else console.log('planet tilejson:', tj.res?.status ?? tj.err);
const style = await get('https://tiles.openfreemap.org/styles/positron');
if (style.res?.ok) {
  const s = await style.res.json();
  const fonts = new Set(); for (const l of s.layers ?? []) for (const f of l.layout?.['text-font'] ?? []) fonts.add(f);
  console.log('positron sources:', Object.keys(s.sources).join(','), '; fonts used:', [...fonts].join(' | '));
}

section('Esri imagery depth over Minneapolis');
const tile = (z) => { const lat = 44.9778, lon = -93.2650; const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor(((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * n);
  return { x, y }; };
for (const z of [18, 19, 20, 21]) {
  const { x, y } = tile(z);
  const r = await get(`https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`, { headers: { Origin: 'https://mngvn.github.io' } });
  console.log(`z${z}:`, r.res?.status, r.res?.headers.get('content-type'), r.res?.headers.get('content-length'), 'ACAO', r.res?.headers.get('access-control-allow-origin'));
}

section('Other regional agencies (discovery only)');
for (const url of [
  'https://svc.metrotransit.org/mtgtfs/mvta/gtfs.zip',
  'https://www.mvta.com/gtfs/google_transit.zip',
  'https://swtransit.org/gtfs/google_transit.zip',
]) {
  const r = await get(url, { method: 'HEAD' });
  console.log(url, '->', r.res?.status ?? r.err);
}
