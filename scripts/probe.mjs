// One-off fact-finding against the real services this app depends on.
// Runs in CI (which has network access); not part of the app.

const section = (t) => console.log(`\n===== ${t} =====`);
const get = async (url, init) => {
  try {
    return { res: await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) }) };
  } catch (err) {
    return { err: String(err) };
  }
};
const origin = { headers: { Origin: 'https://mngvn.github.io' } };

section('OpenFreeMap styles');
for (const name of ['positron', 'dark', 'fiord', 'liberty', 'bright']) {
  const url = `https://tiles.openfreemap.org/styles/${name}`;
  const r = await get(url, origin);
  let extra = '';
  if (r.res?.ok) {
    try {
      const style = await r.res.json();
      const fonts = new Set();
      for (const layer of style.layers ?? []) for (const f of layer.layout?.['text-font'] ?? []) fonts.add(f);
      const bg = style.layers?.find((l) => l.type === 'background')?.paint?.['background-color'];
      extra = `layers=${style.layers?.length} glyphs=${style.glyphs} sources=${Object.keys(style.sources ?? {}).join('|')} bg=${JSON.stringify(bg)} fonts=${[...fonts].join('|')}`;
    } catch (e) {
      extra = 'not json: ' + e;
    }
  }
  console.log(name, '->', r.res?.status ?? r.err, 'ACAO', r.res?.headers.get('access-control-allow-origin'), 'cache', r.res?.headers.get('cache-control'), extra);
}

section('Glyph stacks');
for (const stack of ['Noto Sans Regular', 'Noto Sans Bold', 'Open Sans Regular,Arial Unicode MS Regular', 'Open Sans Regular']) {
  const url = `https://tiles.openfreemap.org/fonts/${encodeURIComponent(stack)}/0-255.pbf`;
  const r = await get(url, origin);
  const size = r.res?.ok ? (await r.res.arrayBuffer()).byteLength : 0;
  console.log(JSON.stringify(stack), '->', r.res?.status ?? r.err, 'bytes', size);
}

section('Tile caching headers (for the offline service worker)');
const tj = await get('https://tiles.openfreemap.org/planet', origin);
if (tj.res?.ok) {
  const tilejson = await tj.res.json();
  console.log('tilejson tiles:', JSON.stringify(tilejson.tiles), 'maxzoom', tilejson.maxzoom);
  const tile = tilejson.tiles[0].replace('{z}', '12').replace('{x}', '987').replace('{y}', '1471');
  const t = await get(tile, origin);
  console.log('tile', tile, '->', t.res?.status, 'ACAO', t.res?.headers.get('access-control-allow-origin'), 'cache', t.res?.headers.get('cache-control'), 'type', t.res?.headers.get('content-type'));
}
const esri = await get('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/12/1471/987', origin);
console.log('esri ->', esri.res?.status, 'ACAO', esri.res?.headers.get('access-control-allow-origin'), 'cache', esri.res?.headers.get('cache-control'));
