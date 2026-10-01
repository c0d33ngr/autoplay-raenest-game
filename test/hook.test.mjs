// hook.test.mjs — drives the actual shipped driver (src/hook.js) inside
// headless Chrome against a synthetic game closure. Verifies lane-avoidance,
// value attraction, stability bias, __start/__gstate, __forceCrash, and the
// crash snapshot. No network, no live game.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function findChrome() {
  if (process.env.RAENEST_CHROME) return process.env.RAENEST_CHROME;
  for (const c of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    try {
      const r = spawnSync('which', [c], { encoding: 'utf8' });
      if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
    } catch { /* keep looking */ }
  }
  return null;
}

// Minimal game closure: just enough of the real game's private state for the
// hook to run. requestAnimationFrame is captured so frames are pumped manually
// from the tests (no real game loop, no physics).
const STUB = `
  var state = 'menu', lane = 1, score = 0, dist = 0, stops = 0, coinsGot = 0,
      level = 1, v = 500, shield = 0, carrying = false,
      roleKey = 'freelancer', cityKey = 'lagos', carX = 150, objs = [];
  function laneX(l) { return 50 + l * 100; }
  function carY() { return 700; }
  function road() { return { lw: 100 }; }
  function getBest() { return 0; }
  function start() { state = 'play'; }
  window.__rafQ = [];
  requestAnimationFrame = function (cb) { window.__rafQ.push(cb); return window.__rafQ.length; };
`;

const hook = fs.readFileSync(path.join(root, 'src', 'hook.js'), 'utf8');
const HARNESS = '<!doctype html><html><body><script>' + STUB + '</script><script>' + hook + '</script></body></html>';

let browser, page;
before(async () => {
  const chrome = findChrome();
  if (!chrome) throw new Error('no Chrome/Chromium found for hook test — set RAENEST_CHROME');
  const mod = await import('puppeteer-core');
  const puppeteer = mod.default || mod;
  browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'raenest-hook-test-')),
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  page = await browser.newPage();
  await page.setContent(HARNESS, { waitUntil: 'domcontentloaded' });
});
after(async () => { if (browser) await browser.close(); });

const pump = n => page.evaluate(m => {
  for (let i = 0; i < m; i++) {
    const q = window.__rafQ.splice(0); // take the queued frames, leave the array empty for re-registration
    q.forEach(cb => cb());
  }
}, n);

test('__start() begins the run and __gstate() mirrors the game state', async () => {
  const g0 = await page.evaluate(() => window.__gstate());
  assert.equal(g0.state, 'menu');
  await page.evaluate(() => window.__start());
  const g = await page.evaluate(() => window.__gstate());
  assert.equal(g.state, 'play');
  assert.equal(g.lane, 1);
  assert.equal(g.role, 'freelancer');
  assert.equal(g.city, 'lagos');
});

test('switches away from a lane with an obstacle in the collision band', async () => {
  await page.evaluate(() => {
    lane = 1; objs.length = 0;
    objs.push({ t: 'obs', k: 'danfo', lane: 1, y: carY() - 80 });
  });
  await pump(1);
  assert.equal(await page.evaluate(() => lane), 0);
  assert.equal(await page.evaluate(() => carX), 50); // laneX(0)
});

test('attracts to a lane with a stop and clear time-to-collision', async () => {
  await page.evaluate(() => {
    lane = 0; objs.length = 0;
    objs.push({ t: 'stop', lane: 2, y: carY() - 300 });
  });
  await pump(1);
  assert.equal(await page.evaluate(() => lane), 2);
});

test('holds the current lane when all lanes are equally safe; trace is sampled', async () => {
  await page.evaluate(() => { lane = 1; objs.length = 0; });
  await pump(4);
  assert.equal(await page.evaluate(() => lane), 1);
  const tr = await page.evaluate(() => window.__trace);
  assert.ok(tr.length >= 1, 'expected trace samples after 4 frames');
  assert.deepEqual(Object.keys(tr[0]).sort(), ['TT', 'carry', 'lane', 'lv', 'score', 'target', 't'].sort());
});

test('__forceCrash() zeroes the shield and plants a guaranteed obstacle', async () => {
  await page.evaluate(() => { state = 'play'; lane = 1; shield = 5; objs.length = 0; });
  assert.equal(await page.evaluate(() => window.__forceCrash()), true);
  const s = await page.evaluate(() => ({ shield, lane, o: objs[0] }));
  assert.equal(s.shield, 0);
  assert.equal(s.o.t, 'obs');
  assert.equal(s.o.lane, s.lane);
  assert.equal(s.o.label, 'crash');
  const rel = s.o.y - 700;
  assert.ok(rel > -140 && rel < 140, 'planted obstacle must start inside the collision band');
});

test('__forceCrash() is a no-op outside of play', async () => {
  await page.evaluate(() => { state = 'over'; });
  assert.equal(await page.evaluate(() => window.__forceCrash()), false);
});

test('records a full crash snapshot on the play -> over transition', async () => {
  await page.evaluate(() => {
    state = 'over'; lane = 0; objs.length = 0;
    objs.push({ t: 'obs', k: 'danfo', lane: 0, y: carY() - 10 });
  });
  await pump(1);
  const c = await page.evaluate(() => window.__crash);
  assert.ok(c, 'crash snapshot missing');
  assert.equal(c.lane, 0);
  assert.equal(c.obs.length, 1);
  assert.equal(c.obs[0].k, 'danfo');
  assert.ok(typeof c.score === 'number');
});
