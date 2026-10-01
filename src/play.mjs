// play.mjs — autonomous Raenest Run agent.
//
// Pipeline: patch game → start local server → open headless Chrome → let the
// in-page driver (src/hook.js) play → stop the run when the score target is
// hit (lock in the margin with a controlled crash) or on natural crash →
// enter the configured name in the game's post box → post to the leaderboard
// → write report + screenshot to out/.
//
// Usage:
//   node src/play.mjs                                  # config.json defaults
//   node src/play.mjs --role founder --margin 0.3      # beat founder all-time by 30%
//   node src/play.mjs --target 200000 --no-post        # fixed target, skip posting
//   node src/play.mjs --target-mode until_crash        # let nature decide
//   node src/play.mjs --headful                        # watch the browser
//
// Flags: --name --role --city --margin --target-mode --target --retries
//        --max-seconds --port --headful --no-post --profile <dir> --video [--video-fps N]
// Exit codes: 0 target met or all-time beaten · 3 finished without target · 1 fatal error.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { startServer } from './server.mjs';
import { fetchBoard, topScore, ROLES, CITIES } from './leaderboard.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = process.argv.slice(2);
const flag = n => { const i = CLI.indexOf('--' + n); return i === -1 ? undefined : CLI[i + 1]; };
const has = n => CLI.includes('--' + n);

const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
if (flag('name')) cfg.name = flag('name');
if (flag('role')) cfg.role = flag('role');
if (flag('city')) cfg.city = flag('city');
if (flag('margin')) cfg.target = { ...cfg.target, mode: 'beat_all_time', margin: +flag('margin') };
if (flag('target-mode')) cfg.target = { ...cfg.target, mode: flag('target-mode') };
if (flag('target')) cfg.target = { ...cfg.target, mode: 'score', score: +flag('target') };
if (flag('retries')) cfg.retries = +flag('retries');
if (flag('max-seconds')) cfg.run = { ...(cfg.run || {}), maxSeconds: +flag('max-seconds') };
if (flag('port')) cfg.port = +flag('port');
if (has('headful')) cfg.browser = { ...(cfg.browser || {}), headless: false };
if (has('no-post')) cfg.post = { ...(cfg.post || {}), enabled: false };
if (flag('profile')) cfg.browser = { ...(cfg.browser || {}), userDataDir: path.resolve(flag('profile')) };
if (has('video')) cfg.video = { ...(cfg.video || {}), enabled: true };
if (has('no-video')) cfg.video = { ...(cfg.video || {}), enabled: false };
if (flag('video-fps')) cfg.video = { ...(cfg.video || {}), fps: +flag('video-fps') };

function die(msg, code = 1) { console.error('play.mjs: ' + msg); process.exit(code); }
if (!ROLES.includes(cfg.role)) die(`invalid role '${cfg.role}' — valid: ${ROLES.join(', ')}`);
if (!CITIES.includes(cfg.city)) die(`invalid city '${cfg.city}' — valid: ${CITIES.join(', ')}`);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const runId = new Date().toISOString().replace(/[:.]/g, '-');
fs.mkdirSync(path.join(root, 'out'), { recursive: true });
const logPath = path.join(root, 'out', `play-${runId}.log`);
const say = m => { const l = `[${new Date().toISOString()}] ${m}`; console.log(l); fs.appendFileSync(logPath, l + '\n'); };

function findChrome() {
  const b = cfg.browser || {};
  if (b.executablePath) return b.executablePath;
  if (process.env.RAENEST_CHROME) return process.env.RAENEST_CHROME;
  if (process.platform === 'darwin') {
    for (const p of ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium']) {
      if (fs.existsSync(p)) return p;
    }
  }
  for (const c of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'msedge']) {
    try {
      const r = spawnSync('which', [c], { encoding: 'utf8' });
      if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
    } catch { /* keep looking */ }
  }
  return null;
}

(async () => {
  let puppeteer;
  try {
    const mod = await import('puppeteer-core');
    puppeteer = mod.default || mod;
  } catch { die('puppeteer-core is not installed — run: npm install'); }

  say(`config: name='${cfg.name}' role=${cfg.role} city=${cfg.city} port=${cfg.port} post=${cfg.post?.enabled !== false}`);

  // ---- 1) target ----------------------------------------------------------
  let allTime = null, target, targetSrc;
  const mode = cfg.target.mode;
  if (mode === 'beat_all_time') {
    allTime = await topScore(cfg.apiBase, cfg.role, 'all');
    if (!allTime) die(`could not read the all-time board for '${cfg.role}' (${cfg.apiBase} unreachable or empty)`);
    const margin = cfg.target.margin ?? 0.2;
    target = Math.ceil(allTime * (1 + margin));
    targetSrc = `all-time top ${allTime} × (1+${margin})`;
  } else if (mode === 'score') {
    target = cfg.target.score ?? 0;
    targetSrc = 'fixed score';
  } else if (mode === 'until_crash') {
    target = Infinity;
    targetSrc = 'no cap — run until natural crash';
  } else die(`target.mode must be 'beat_all_time' | 'score' | 'until_crash', got '${mode}'`);
  say(`target: ${target === Infinity ? '∞' : target} (${targetSrc})`);

  // ---- 2) build + serve ---------------------------------------------------
  const bp = spawnSync(process.execPath, [path.join(root, 'src', 'patch.mjs')], { encoding: 'utf8' });
  if (bp.status !== 0) die('patch step failed:\n' + (bp.stderr || '') + (bp.stdout || ''));
  say('built: ' + (bp.stdout || '').trim());
  const srv = await startServer({ port: cfg.port, apiBase: cfg.apiBase, log: false });
  say('server: ' + srv.url + ' (leaderboard proxied → ' + cfg.apiBase + ')');

  // ---- 3) browser ---------------------------------------------------------
  const chrome = findChrome();
  if (!chrome) die('no Chrome/Chromium found — set browser.executablePath in config.json, or RAENEST_CHROME env, or install Chrome');
  const headless = (cfg.browser || {}).headless !== false;
  const profileDir = path.resolve((cfg.browser || {}).userDataDir || path.join(root, 'out', 'profile'));
  fs.mkdirSync(profileDir, { recursive: true });
  say(`browser: ${chrome} (headless=${headless}, profile=${profileDir})`);
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: chrome,
      headless,
      userDataDir: profileDir,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=480,940'],
    });
  } catch (e) {
    const lockBusy = (() => { try { return fs.lstatSync(path.join(profileDir, 'SingletonLock')).isSymbolicLink(); } catch { return false; } })();
    die('browser launch failed: ' + e.message + (lockBusy
      ? '\n  hint: ' + profileDir + ' has a SingletonLock — another browser is using this profile, or a stale lock survived a crash. Wait for it to exit, delete the lock file, or pass --profile <dir>.'
      : '\n  hint: if it looks like a CDP/version mismatch, point browser.executablePath at a Chrome matching your puppeteer-core (npm i puppeteer-core@<tag>) or use RAENEST_CHROME'));
  }

  let page;
  try {
    page = await browser.newPage();
    await page.setViewport({ width: 430, height: 900 });
    // Seed identity + role/city before the game script reads localStorage.
    await page.evaluateOnNewDocument(({ role, city, name }) => {
      localStorage.setItem('rn-run-role', role);
      localStorage.setItem('rn-run-city', city);
      localStorage.setItem('rn-run-name', name);
    }, { role: cfg.role, city: cfg.city, name: cfg.name });
    await page.goto(srv.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction('typeof window.__start === "function"', { timeout: 20000 });
  } catch (e) {
    die('page setup failed: ' + e.message);
  }
  const gs = () => page.evaluate(() => window.__gstate());
  const g0 = await gs();
  const fingerprint = await page.evaluate(() => localStorage.getItem('rn-run-pid'));
  if (g0.role !== cfg.role || g0.city !== cfg.city) die(`role/city did not apply (got role=${g0.role} city=${g0.city})`);
  // Fail fast if upstream renamed/moved the over-card elements we depend on —
  // better to die here than mid-run with a 45 s #postBtn wait.
  const REQUIRED_IDS = ['overTitle', 'overReason', 'oScore', 'oStops', 'oDist', 'oCoins', 'oBest', 'nameIn', 'postBtn', 'postStatus', 'resumeBtn'];
  const missingIds = await page.evaluate(ids => ids.filter(id => !document.getElementById(id)), REQUIRED_IDS);
  if (missingIds.length) {
    await browser.close().catch(() => {});
    die('game DOM changed — required element(s) missing: ' + missingIds.join(', ') + ' (upstream raenest.html renamed/moved them; update REQUIRED_IDS in play.mjs)');
  }
  say(`page ready: state=${g0.state} role=${g0.role} city=${g0.city} fingerprint=${fingerprint}`);

  // ---- video: CDP page screencast -> ffmpeg -> mp4 (phone-sized) ----------
  // Records the whole session (menu -> run(s) -> over card -> post) in the
  // page's own 430x900 size. Chrome delivers frames at display rate and only
  // sends the next frame after the previous one is acked, so delaying acks
  // paces the stream to the configured fps (ack param = event's sessionId).
  let cdp = null, ffmpeg = null, videoPath = null, vFrames = 0, vPending = null, vTimer = null, vLastAt = 0;
  const vInterval = Math.max(20, Math.round(1000 / Math.max(1, Math.min(60, Math.round(cfg.video?.fps ?? 10)))));
  const vWrite = f => {
    if (!ffmpeg || ffmpeg.exitCode !== null || ffmpeg.stdin.destroyed) return;
    try { ffmpeg.stdin.write(Buffer.from(f.data, 'base64')); } catch { /* ffmpeg died */ }
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  };
  if (cfg.video?.enabled) {
    try {
      const fps = Math.max(1, Math.min(60, Math.round(cfg.video.fps ?? 10)));
      videoPath = path.join(root, 'out', 'video', `run-${runId}.mp4`);
      fs.mkdirSync(path.dirname(videoPath), { recursive: true });
      ffmpeg = spawn('ffmpeg', ['-y', '-f', 'image2pipe', '-framerate', String(fps), '-i', 'pipe:0',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '28', videoPath],
        { stdio: ['pipe', 'ignore', 'ignore'] });
      ffmpeg.on('error', e => say(`video: ffmpeg error: ${e.message} — continuing without video`));
      cdp = await page.createCDPSession();
      cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
        const f = { data, sessionId };
        const now = Date.now();
        if (now - vLastAt >= vInterval) { vLastAt = now; vFrames++; vWrite(f); }
        else {
          vPending = f;
          if (!vTimer) vTimer = setTimeout(() => {
            vTimer = null; vLastAt = Date.now();
            if (vPending) { const p = vPending; vPending = null; vFrames++; vWrite(p); }
          }, vInterval - (now - vLastAt));
        }
      });
      await cdp.send('Page.startScreencast', { format: 'jpeg', quality: cfg.video.quality ?? 70, maxWidth: 430, maxHeight: 900 });
      say(`video: recording ${fps} fps -> ${path.relative(root, videoPath)}`);
    } catch (e) {
      say(`video: failed to start (${e.message}) — continuing without video`);
      cdp = null;
      try { ffmpeg?.kill(); } catch { /* ignore */ }
      ffmpeg = null;
    }
  }
  async function stopVideo() {
    if (!cdp) return null;
    try { await cdp.send('Page.stopScreencast'); } catch { /* ignore */ }
    try { ffmpeg?.stdin.end(); } catch { /* ignore */ }
    if (ffmpeg && ffmpeg.exitCode === null) await Promise.race([new Promise(r => ffmpeg.on('close', r)), sleep(10000)]);
    cdp = null; ffmpeg = null;
    const rel = videoPath && fs.existsSync(videoPath) ? path.relative(root, videoPath) : null;
    if (rel) say(`video: ${vFrames} frames captured -> ${rel}`);
    return rel;
  }

  // ---- 4) play: attempts until target or out of retries -------------------
  // Every attempt that reaches the over-card gets posted (name + score) —
  // target-hit, capped, or natural crash. The leaderboard keeps the player's
  // best, so a high early attempt stays on the board even if later ones crash.
  const maxAttempts = Math.max(1, cfg.retries ?? 1);
  const postEnabled = cfg.post?.enabled !== false;
  const attempts = [];
  let fin = null;
  let lastOver = null, lastHit = false, lastCapped = false, lastAttempt = 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    lastAttempt = attempt;
    say(`--- attempt ${attempt}/${maxAttempts}: __start() ---`);
    await page.evaluate(() => window.__start());
    const t0 = Date.now();
    let lastLog = 0, hitTarget = false, capped = false, over = null, forceAt = 0;
    while (!over) {
      await sleep(250);
      const g = await gs();
      const el = (Date.now() - t0) / 1000;
      if (g.state === 'pause') { // defensive: resume and keep waiting
        await page.evaluate(() => { const b = document.getElementById('resumeBtn'); if (b) b.click(); });
        continue;
      }
      if (g.state === 'over') { over = { g, el }; break; }
      if (el - lastLog >= 15) {
        lastLog = el;
        say(`  t=${Math.round(el)}s score=${g.score}${target === Infinity ? '' : '/' + target} lv=${g.level} lane=${g.lane} v=${g.v} stops=${g.stops} shield=${g.shield}`);
      }
      if (!hitTarget && target !== Infinity && g.score >= target) {
        say(`  TARGET HIT: score ${g.score} ≥ ${target} at t=${Math.round(el)}s (lv ${g.level}) — locking in the margin via controlled crash`);
        await page.evaluate(() => window.__forceCrash());
        hitTarget = true; forceAt = Date.now();
      } else if (cfg.run?.maxSeconds && el >= cfg.run.maxSeconds) {
        say(`  maxSeconds(${cfg.run.maxSeconds}) cap reached — ending run`);
        await page.evaluate(() => window.__forceCrash());
        capped = true; forceAt = Date.now();
      }
      if ((hitTarget || capped) && forceAt && Date.now() - forceAt > 6000) { // stop should land on the next frame; re-arm if it did not
        say(`  still playing ${Math.round((Date.now() - forceAt) / 1000)}s after controlled stop — re-arming`);
        await page.evaluate(() => window.__forceCrash());
        forceAt = Date.now();
      }
    }
    lastOver = over; lastHit = hitTarget; lastCapped = capped;
    attempts.push({
      attempt, score: over.g.score, level: over.g.level, stops: over.g.stops,
      km: +(over.g.dist / 10000).toFixed(1), durationSec: Math.round(over.el),
      stoppedByTarget: hitTarget, stoppedByCap: capped, naturalCrash: !hitTarget && !capped,
    });
    if (hitTarget || capped) break; // no retry: run was deliberately ended
    if (attempt < maxAttempts) {
      const p = await postAttempt(); // keep this attempt's score on the board
      attempts[attempt - 1].posted = p.posted;
      say(`  natural crash at t=${Math.round(over.el)}s score=${over.g.score} (lv ${over.g.level})${p.posted ? ' — posted' : ' — post failed'} — restarting attempt`);
      await sleep(1500);
      continue;
    }
    fin = await finish(over, attempt, { hitTarget, capped });
  }
  if (!fin) fin = await finish(lastOver, lastAttempt, { hitTarget: lastHit, capped: lastCapped });

  // ---- 5) done ------------------------------------------------------------
  await browser.close();
  await srv.close();
  const bestScore = attempts.length ? Math.max(...attempts.map(a => a.score)) : 0;
  const met = attempts.some(a => a.stoppedByTarget) || (allTime != null && bestScore > allTime);
  say(`RESULT ${JSON.stringify({ bestScore, attempts: attempts.length, allTime, target: target === Infinity ? null : target, finalStoppedByTarget: fin.stoppedByTarget, finalPosted: fin.posted, report: fin.report })}`);
  process.exitCode = met ? 0 : 3;

  // One over-card visit: wait for the card, read the panel, post the score.
  async function postAttempt() {
    await sleep(1200); // the game reveals the over card ~750 ms after crash
    let panel = {};
    try {
      panel = await page.evaluate(() => {
        const $ = id => document.getElementById(id);
        return {
          title: $('overTitle').textContent, reason: $('overReason').textContent,
          score: $('oScore').textContent, stops: $('oStops').textContent,
          dist: $('oDist').textContent, coins: $('oCoins').textContent, best: $('oBest').textContent,
        };
      });
    } catch (e) { panel = { error: String(e.message || e) }; }
    if (!postEnabled) return { posted: null, postStatus: null, panel };
    let posted = null, postStatus = null;
    try {
      await page.evaluate(n => {
        const i = document.getElementById('nameIn');
        i.value = n;
        i.dispatchEvent(new Event('input', { bubbles: true }));
      }, cfg.name);
      await page.click('#postBtn');
      await page.waitForFunction(() => {
        const b = document.getElementById('postBtn');
        // note: on success the game leaves the button disabled — do NOT require !b.disabled
        return b && (b.textContent === 'Posted' || b.textContent === 'Try again');
      }, { timeout: 45000 });
      posted = await page.evaluate(() => document.getElementById('postBtn').textContent === 'Posted');
      postStatus = await page.evaluate(() => document.getElementById('postStatus').textContent);
    } catch {
      posted = false;
      postStatus = 'post did not complete (timeout or page state)';
    }
    say(`post: ${posted ? 'POSTED' : 'FAILED — ' + postStatus + ' · re-post later with: node src/post.mjs --report <report.json>'}`);
    return { posted, postStatus, panel };
  }

  async function finish({ g, el }, attempt, flags) {
    const p = await postAttempt();
    let crash = null, traceTail = [];
    try { crash = await page.evaluate(() => window.__crash); } catch { /* best effort */ }
    try { traceTail = await page.evaluate(() => window.__trace.slice(-80)); } catch { /* best effort */ }
    let fingerprintNow = null;
    try { fingerprintNow = await page.evaluate(() => localStorage.getItem('rn-run-pid')); } catch { /* best effort */ }
    const screenshot = path.join(root, 'out', `run-${runId}-a${attempt}.png`);
    try { await page.screenshot({ path: screenshot }); } catch { /* best effort */ }
    const videoRel = await stopVideo();
    const report = {
      runId, at: new Date().toISOString(),
      config: { name: cfg.name, role: cfg.role, city: cfg.city, apiBase: cfg.apiBase, port: cfg.port,
        targetMode: mode, margin: cfg.target.margin ?? null, targetScore: cfg.target.score ?? null,
        retries: maxAttempts, maxSeconds: cfg.run?.maxSeconds ?? 0, post: postEnabled },
      fingerprint: fingerprintNow || fingerprint, allTime, target: target === Infinity ? null : target, targetSource: targetSrc,
      attempts,
      attempt, durationSec: Math.round(el),
      stoppedByTarget: !!flags.hitTarget, stoppedByCap: !!flags.capped, naturalCrash: !flags.hitTarget && !flags.capped,
      score: g.score, dist: Math.round(g.dist), km: +(g.dist / 10000).toFixed(1),
      stops: g.stops, coins: g.coinsGot, level: g.level,
      beatAllTime: allTime != null ? g.score > allTime : null,
      marginOverAllTime: allTime ? +((g.score / allTime - 1) * 100).toFixed(1) + ' %' : null,
      posted: p.posted, postStatus: p.postStatus, panel: p.panel, crash, traceTail,
      screenshot: path.relative(root, screenshot),
      video: videoRel,
    };
    const reportPath = path.join(root, 'out', `report-${runId}-a${attempt}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    say(`report: ${path.relative(root, reportPath)}`);
    return { ...report, report: path.relative(root, reportPath) };
  }
})().catch(e => {
  console.error('play.mjs fatal:', e);
  process.exit(1);
});
