// TEMPORARY: drives the static build against live Metro Transit, live
// aircraft through the relay, and live adsbdb lookups, and reports what it
// sees. Removed before the pull request.
import { chromium } from 'playwright';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
// However it goes, the job says what it saw and ends.
setTimeout(() => { log('WATCHDOG: giving up after 9 minutes'); process.exit(3); }, 9 * 60_000).unref();
log('launching');
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript(() => localStorage.setItem('livetrains.onboarded', '1'));
const page = await context.newPage();
page.setDefaultTimeout(45000);
const relayHits = [];
page.on('pageerror', (e) => log('pageerror', e.message));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') log('console', m.type(), m.text().slice(0, 240)); });
page.on('requestfailed', (r) => { if (/8787|adsbdb/.test(r.url())) log('requestfailed', r.url(), r.failure()?.errorText); });
page.on('response', (r) => {
  if (r.url().includes(':8787/')) relayHits.push(Date.now());
  if (r.url().includes('adsbdb')) log('adsbdb', r.status(), r.url().replace('https://api.adsbdb.com/v0', ''), 'acao=' + (r.headers()['access-control-allow-origin'] ?? 'none'));
});

log('opening the app');
await page.goto('http://127.0.0.1:4173/');
const progress = setInterval(async () => {
  log('waiting:', (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160));
}, 20000);
await page.waitForSelector('.sheet .tabs', { timeout: 240000 });
await page.waitForFunction(() => window.__livetrainsMap?.getLayer('planes-hit'), null, { timeout: 60000 });
clearInterval(progress);
log('app ready:', (await page.locator('.status-bar').innerText().catch(() => '')).replace(/\n/g, ' | '));
await page.waitForTimeout(12000);

await page.locator('.legend__toggle').click();
log('legend:', (await page.locator('.legend__item', { hasText: 'Aircraft' }).innerText().catch(() => 'NO AIRCRAFT ROW')).replace(/\n/g, ' | '));
await page.locator('.legend__toggle').click();
log('attribution:', (await page.locator('.maplibregl-ctrl-attrib-inner').innerText().catch(() => '')).replace(/\n/g, ' '));

const sky = await page.evaluate(() => {
  const m = window.__livetrainsMap;
  const all = m.querySourceFeatures('planes').map((f) => f.properties);
  const byId = new Map(all.map((p) => [p.id, p]));
  return [...byId.values()].map((p) => `${p.label}@${p.alt}${p.stale ? '(stale)' : ''}/${p.shape}`);
});
log(`planes drawn: ${sky.length}`, sky.join(' '));

// Smooth motion: where one plane is drawn over three seconds.
const track = await page.evaluate(async () => {
  const m = window.__livetrainsMap;
  const first = m.querySourceFeatures('planes').find((f) => !f.properties.stale && f.properties.alt > 1000);
  if (!first) return null;
  const id = first.properties.id;
  const out = [];
  for (let i = 0; i < 4; i++) {
    const f = m.querySourceFeatures('planes').find((x) => x.properties.id === id);
    out.push(f ? f.geometry.coordinates.map((n) => n.toFixed(5)).join(',') : 'gone');
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { label: first.properties.label, positions: out };
});
log('one plane over 3s:', JSON.stringify(track));

// Tap airline flights and read their panels.
const targets = await page.evaluate(() => {
  const seen = new Set();
  return window.__livetrainsMap.querySourceFeatures('planes')
    .map((f) => ({ id: f.properties.id, label: f.properties.label, alt: f.properties.alt, at: f.geometry.coordinates }))
    .filter((p) => !seen.has(p.id) && seen.add(p.id) && /^[A-Z]{3}\d/.test(p.label) && p.alt > 0)
    .slice(0, 5);
});
for (const t of targets) {
  await page.evaluate((c) => window.__livetrainsMap.jumpTo({ center: c, zoom: 12 }), t.at);
  await page.waitForTimeout(900);
  const at = await page.evaluate((id) => { const m = window.__livetrainsMap; const f = m.queryRenderedFeatures({ layers: ['planes-hit'] }).find((x) => x.properties.id === id); return f && m.project(f.geometry.coordinates); }, t.id);
  if (!at) { log(t.label, 'not rendered'); continue; }
  await page.mouse.click(at.x, at.y);
  await page.waitForTimeout(4500);
  log(`panel ${t.label}:`, (await page.locator('.detail').innerText().catch(() => 'NO PANEL')).replace(/\n+/g, ' | '));
}
await page.keyboard.press('Escape');

// Polling cadence, and that a hidden tab stops asking.
const before = relayHits.length;
await page.waitForTimeout(30000);
log(`relay requests in 30s visible: ${relayHits.length - before}`);
await page.evaluate(() => {
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
});
const hiddenBefore = relayHits.length;
await page.waitForTimeout(25000);
log(`relay requests in 25s hidden: ${relayHits.length - hiddenBefore}`);
await browser.close();
log('done');
process.exit(0);
