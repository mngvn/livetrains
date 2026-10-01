// TEMPORARY: drives the built app against real Metro Transit data and saves
// screenshots for review. Removed before the pull request.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = '/tmp/shoot/out';
mkdirSync(OUT, { recursive: true });
const URL = 'http://127.0.0.1:4173/';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const browser = await chromium.launch();
/** The stop link the app writes into the address bar, reused as a shared link. */
let sharedStop = '';

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
  page.on('pageerror', (e) => log('pageerror', e.message));
  page.on('console', (m) => { if (m.type() === 'error') log('console', m.text().slice(0, 200)); });
  await page.goto(URL + query, { waitUntil: 'domcontentloaded' });
  return { context, page };
}

const ready = async (page) => {
  await page.waitForSelector('.sheet .tabs', { timeout: 180000 });
  await page.waitForFunction(() => window.__livetrainsMap?.getLayer('vehicles-hit'), null, { timeout: 60000 });
  // Let tiles, the network and the first vehicle poll arrive.
  await page.waitForTimeout(9000);
};
const shot = (page, name) => page.screenshot({ path: `${OUT}/${name}.png` }).then(() => log('shot', name));
const jump = (page, center, zoom) => page.evaluate(([c, z]) => window.__livetrainsMap.jumpTo({ center: c, zoom: z }), [center, zoom]);

// --- Desktop, dark ----------------------------------------------------------
{
  const { context, page } = await session();
  await page.waitForTimeout(1500);
  await shot(page, '01-loading');
  await ready(page);
  log('status:', (await page.locator('.status-bar').innerText()).replace(/\n/g, ' | '));
  await shot(page, '02-network');

  await jump(page, [-93.2650, 44.9770], 13.6);
  await page.waitForTimeout(4000);
  await shot(page, '03-downtown');

  await jump(page, [-93.2700, 44.9785], 16);
  await page.waitForTimeout(4000);
  await shot(page, '04-street');

  // A stop's board.
  await page.locator('.transit-search__input').fill('Nicollet Mall Station');
  await page.waitForSelector('.transit-search__result', { timeout: 15000 });
  await page.locator('.transit-search__result').first().click();
  await page.waitForSelector('.detail .board-row', { timeout: 30000 });
  await page.waitForTimeout(3000);
  await shot(page, '05-stop-board');
  sharedStop = await page.evaluate(() => location.search);
  log('stop link:', sharedStop);

  // How far in 30 minutes.
  await page.locator('.detail .chip', { hasText: 'How far in 30 min' }).click();
  await page.waitForSelector('.reach-legend', { timeout: 30000 });
  await page.waitForTimeout(4000);
  await shot(page, '06-reach');
  await page.locator('.detail .chip', { hasText: 'Hide reach' }).click();
  await page.keyboard.press('Escape');

  // A light-rail vehicle: outline drawn on, everything else dimmed.
  await jump(page, [-93.2470, 44.9600], 12.8);
  await page.waitForTimeout(3000);
  const target = await page.evaluate(() => {
    const m = window.__livetrainsMap;
    const c = m.getCanvas();
    const hits = m.queryRenderedFeatures({ layers: ['vehicles-hit'] })
      .map((f) => ({ f, p: m.project(f.geometry.coordinates) }))
      .filter(({ p }) => p.x > 440 && p.x < c.clientWidth - 440 && p.y > 100 && p.y < c.clientHeight - 100);
    const rail = hits.find(({ f }) => f.properties.mode === 'tram') ?? hits[0];
    return rail ? { x: rail.p.x, y: rail.p.y } : null;
  });
  if (target) {
    await page.mouse.click(target.x, target.y);
    await page.waitForTimeout(450);
    await shot(page, '07-vehicle-drawing-on');
    await page.waitForTimeout(3500);
    await shot(page, '08-vehicle');
    await page.keyboard.press('Escape');
  }

  // The network status board.
  await page.locator('.tab', { hasText: 'Status' }).click();
  await jump(page, [-93.2, 44.97], 10.4);
  await page.waitForTimeout(4000);
  log('status board:', (await page.locator('.network__head').innerText()).replace(/\n/g, ' | '));
  await shot(page, '09-status');

  // A trip.
  await page.locator('.tab', { hasText: 'Plan' }).click();
  const pick = async (label, text) => {
    await page.locator('.place-search').filter({ hasText: label }).locator('input').fill(text);
    await page.waitForSelector('.place-search__result', { timeout: 15000 });
    await page.locator('.place-search__result').first().click();
  };
  await pick('From', 'Target Field');
  await pick('To', 'Union Depot');
  await page.waitForSelector('.itinerary-summary', { timeout: 30000 }).catch(() => log('no itinerary'));
  await page.waitForTimeout(4000);
  await shot(page, '10-trip');
  await context.close();
}

// --- Desktop, light ---------------------------------------------------------
{
  const { context, page } = await session({ theme: 'light' });
  await ready(page);
  await jump(page, [-93.2650, 44.9770], 13.2);
  await page.waitForTimeout(4000);
  await shot(page, '11-light-downtown');
  await context.close();
}

// --- Phone ------------------------------------------------------------------
{
  const { context, page } = await session({ width: 390, height: 844, phone: true });
  await ready(page);
  await shot(page, '12-phone-home');
  await context.close();
}

// --- A shared stop link, as a first-time visitor ----------------------------
{
  const { context, page } = await session({ query: sharedStop });
  await ready(page);
  await shot(page, '13-shared-stop');
  await context.close();
}

await browser.close();
log('done');
