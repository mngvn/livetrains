// TEMPORARY: drives the built app against real Metro Transit data and real
// map tiles, saves screenshots, and reports what was drawn as text. Removed
// before the pull request.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = '/tmp/shoot/out';
mkdirSync(OUT, { recursive: true });
const URL = 'http://127.0.0.1:4173/';
const T0 = Date.now();
const log = (...a) => console.log(`+${((Date.now() - T0) / 1000).toFixed(1)}s`, ...a);

const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
/** The stop link the app writes into the address bar, reused as a shared link. */
let sharedStop = '';

/** Console traffic, counted rather than kept: a flood must not fill this process. */
const consoleCounts = new Map();
const consoleFirst = new Map();
function watchConsole(page) {
  page.on('console', (m) => {
    const type = m.type();
    consoleCounts.set(type, (consoleCounts.get(type) ?? 0) + 1);
    if (type === 'error' || type === 'warning') {
      const text = m.text().slice(0, 160);
      if (consoleFirst.size < 25 && !consoleFirst.has(text)) consoleFirst.set(text, type);
    }
  });
  page.on('pageerror', (e) => log('PAGEERROR', e.message.slice(0, 200)));
}
const consoleReport = (label) =>
  log(`console after ${label}:`, JSON.stringify(Object.fromEntries(consoleCounts)));

async function session({ width = 1440, height = 900, theme = 'dark', phone = false, query = '' } = {}) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: phone ? 2 : 1,
    ...(phone ? { isMobile: true, hasTouch: true } : {}),
  });
  await context.addInitScript((t) => {
    localStorage.setItem('livetrains.onboarded', '1');
    localStorage.setItem('livetrains.theme', t);
  }, theme);
  const page = await context.newPage();
  page.setDefaultTimeout(45000);
  watchConsole(page);
  await page.goto(URL + query, { waitUntil: 'domcontentloaded' });
  return { context, page };
}

const ready = async (page) => {
  await page.waitForSelector('.sheet .tabs', { timeout: 180000 });
  await page.waitForFunction(() => window.__livetrainsMap?.getLayer('vehicles-hit'), null, { timeout: 60000 });
  await page.waitForTimeout(9000);
};
const shot = async (page, name) => {
  const t = Date.now();
  await page.screenshot({ path: `${OUT}/${name}.png`, timeout: 60000 });
  log('shot', name, `(${Date.now() - t}ms)`);
};
const jump = (page, center, zoom) =>
  page.evaluate(([c, z]) => window.__livetrainsMap.jumpTo({ center: c, zoom: z }), [center, zoom]);

/** Frames the page manages in two seconds, and how busy its heap is. */
const vitals = (page, label) =>
  page
    .evaluate(
      () =>
        new Promise((resolve) => {
          let frames = 0;
          const start = performance.now();
          const tick = () => {
            frames++;
            if (performance.now() - start < 2000) requestAnimationFrame(tick);
            else
              resolve({
                fps: Math.round(frames / 2),
                heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : null,
              });
          };
          requestAnimationFrame(tick);
        }),
    )
    .then((v) => log(`vitals ${label}:`, JSON.stringify(v)))
    .catch((e) => log(`vitals ${label} failed:`, e.message.slice(0, 120)));

/** How many features each layer actually drew, which says whether tiles, data and thinning work. */
const drawn = (page, label) =>
  page
    .evaluate(() => {
      const m = window.__livetrainsMap;
      const count = (id) => {
        if (!m.getLayer(id)) return '-';
        try {
          return m.queryRenderedFeatures({ layers: [id] }).length;
        } catch (e) {
          return 'err';
        }
      };
      const ids = [
        'water', 'park', 'landcover', 'building', 'road-major', 'road-mid', 'road-minor', 'railway',
        'label-water', 'label-street', 'label-neighbourhood', 'label-city', 'ground-texture',
        'network-line', 'network-casing', 'network-highlight', 'major-stops-circle', 'major-stops-label',
        'major-stop-badges', 'stops-circle', 'stops-label', 'vehicles-dot', 'vehicles-glyph', 'vehicles-label',
        'vehicle-groups-circle', 'isochrone-fill', 'vehicle-trip-line',
      ];
      const out = { zoom: +m.getZoom().toFixed(1), tilesLoaded: m.areTilesLoaded() };
      for (const id of ids) out[id] = count(id);
      return out;
    })
    .then((d) => log(`drawn ${label}:`, JSON.stringify(d)))
    .catch((e) => log(`drawn ${label} failed:`, e.message.slice(0, 120)));

async function step(name, fn) {
  log('>>', name);
  try {
    await fn();
  } catch (e) {
    log('!! step failed:', name, e.message.split('\n')[0].slice(0, 200));
  }
  consoleReport(name);
}

// --- Desktop, dark ----------------------------------------------------------
{
  const { context, page } = await session();
  await step('loading', async () => {
    await page.waitForTimeout(1500);
    await shot(page, '01-loading');
    await ready(page);
    log('status:', (await page.locator('.status-bar').innerText()).replace(/\n/g, ' | '));
  });
  await step('network', async () => {
    await vitals(page, 'network');
    await drawn(page, 'network');
    await shot(page, '02-network');
  });
  await step('downtown', async () => {
    await jump(page, [-93.265, 44.977], 13.6);
    await page.waitForTimeout(5000);
    await vitals(page, 'downtown');
    await drawn(page, 'downtown');
    await shot(page, '03-downtown');
  });
  await step('street', async () => {
    await jump(page, [-93.27, 44.9785], 16);
    await page.waitForTimeout(5000);
    await drawn(page, 'street');
    await shot(page, '04-street');
  });
  await step('stop board', async () => {
    await page.locator('.transit-search__input').fill('Nicollet Mall Station');
    await page.waitForSelector('.transit-search__result', { timeout: 15000 });
    await page.locator('.transit-search__result').first().click();
    await page.waitForSelector('.detail .board-row', { timeout: 30000 });
    await page.waitForTimeout(3000);
    log('board:', (await page.locator('.board__count').innerText()), '| rows', await page.locator('.board-row').count());
    await shot(page, '05-stop-board');
    sharedStop = await page.evaluate(() => location.search);
    log('stop link:', sharedStop);
  });
  await step('reach', async () => {
    const t = Date.now();
    await page.locator('.detail .chip', { hasText: 'How far in 30 min' }).click();
    await page.waitForSelector('.reach-legend', { timeout: 60000 });
    log('reach ready in', Date.now() - t, 'ms; cells', await page.evaluate(() => window.__livetrainsMap.querySourceFeatures('isochrone').length));
    await page.waitForTimeout(4000);
    await vitals(page, 'reach');
    await drawn(page, 'reach');
    await shot(page, '06-reach');
  });
  await step('clear reach', async () => {
    await page.evaluate(() => document.querySelector('.reach-legend .icon-button')?.click());
    await page.waitForTimeout(500);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    await vitals(page, 'after reach');
  });
  await step('vehicle', async () => {
    await jump(page, [-93.247, 44.96], 12.8);
    await page.waitForTimeout(4000);
    const target = await page.evaluate(() => {
      const m = window.__livetrainsMap;
      const c = m.getCanvas();
      const hits = m
        .queryRenderedFeatures({ layers: ['vehicles-hit'] })
        .map((f) => ({ mode: f.properties.mode, p: m.project(f.geometry.coordinates) }))
        .filter(({ p }) => p.x > 440 && p.x < c.clientWidth - 440 && p.y > 100 && p.y < c.clientHeight - 100);
      const rail = hits.find((h) => h.mode === 'tram') ?? hits[0];
      return rail ? { x: rail.p.x, y: rail.p.y, mode: rail.mode, of: hits.length } : null;
    });
    log('vehicle target:', JSON.stringify(target));
    if (!target) return;
    await page.mouse.click(target.x, target.y);
    await page.waitForTimeout(450);
    await shot(page, '07-vehicle-drawing-on');
    await page.waitForTimeout(3500);
    await drawn(page, 'vehicle');
    log('vehicle panel:', (await page.locator('.detail').innerText().catch(() => 'none')).split('\n').slice(0, 8).join(' | '));
    await shot(page, '08-vehicle');
    await page.keyboard.press('Escape');
  });
  await step('status board', async () => {
    await page.locator('.tab', { hasText: 'Status' }).click();
    await jump(page, [-93.2, 44.97], 10.4);
    await page.waitForTimeout(5000);
    log('status board:', (await page.locator('.network').innerText()).split('\n').slice(0, 24).join(' | '));
    await shot(page, '09-status');
  });
  await step('trip', async () => {
    await page.locator('.tab', { hasText: 'Plan' }).click();
    const pick = async (label, text) => {
      await page.locator('.place-search').filter({ hasText: label }).locator('input').fill(text);
      await page.waitForSelector('.place-search__result', { timeout: 15000 });
      await page.locator('.place-search__result').first().click();
    };
    await pick('From', 'Target Field');
    await pick('To', 'Union Depot');
    await page.waitForSelector('.itinerary-summary', { timeout: 30000 });
    await page.waitForTimeout(4000);
    log('first itinerary:', (await page.locator('.itinerary-summary').first().innerText()).replace(/\n/g, ' | '));
    await shot(page, '10-trip');
  });
  await context.close();
}

// --- Desktop, light ---------------------------------------------------------
{
  const { context, page } = await session({ theme: 'light' });
  await step('light', async () => {
    await ready(page);
    await jump(page, [-93.265, 44.977], 13.2);
    await page.waitForTimeout(5000);
    await drawn(page, 'light downtown');
    await shot(page, '11-light-downtown');
  });
  await context.close();
}

// --- Phone ------------------------------------------------------------------
{
  const { context, page } = await session({ width: 390, height: 844, phone: true });
  await step('phone', async () => {
    await ready(page);
    await shot(page, '12-phone-home');
  });
  await context.close();
}

// --- A shared stop link, as a first-time visitor ----------------------------
if (sharedStop) {
  const { context, page } = await session({ query: sharedStop });
  await step('shared stop', async () => {
    await ready(page);
    log('shared stop:', await page.evaluate(() => ({ zoom: window.__livetrainsMap.getZoom().toFixed(1), detail: document.querySelector('.detail .panel-title')?.textContent })).then(JSON.stringify));
    await shot(page, '13-shared-stop');
  });
  await context.close();
}

log('console messages seen (first of each):');
for (const [text, type] of consoleFirst) log(`  [${type}] ${text}`);
await browser.close();
log('done');
