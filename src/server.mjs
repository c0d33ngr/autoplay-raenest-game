// server.mjs — local game server: serves the patched game at / and proxies
// /api/scores to the real Raenest leaderboard API (default: fun.raenest.com),
// so the game plays fully offline-ish while posting/scoreboard stays live.
//
// Run standalone:  node src/server.mjs        (reads config.json: port, apiBase)
// Or embed:        import { startServer } from './server.mjs'
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HOP = /^(host|content-length|connection|transfer-encoding|keep-alive|proxy-authentication|proxy-authorization|te|upgrade|origin|referer|user-agent|cookie|cookie2)$/i;
const SKIP_RESP = /^(content-encoding|content-length|transfer-encoding|connection|set-cookie)$/i;

function readBody(req) {
  return new Promise((res, rej) => {
    const chunks = [];
    req.on('data', d => chunks.push(d));
    req.on('end', () => res(chunks.length ? Buffer.concat(chunks) : undefined));
    req.on('error', rej);
  });
}
export async function startServer({ port = 8321, apiBase = 'https://fun.raenest.com', htmlPath = null, hostname = '127.0.0.1', log = true } = {}) {
  const htmlFile = htmlPath || path.join(root, 'out', 'raenest.patched.html');
  const note = m => log && console.error(`[server] ${m}`);
  const loadHtml = () => fs.readFileSync(htmlFile, 'utf8'); // re-read per request: re-patching takes effect without restart
  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, `http://${hostname}`);
      if (u.pathname === '/' || u.pathname === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(loadHtml());
      }
      if (u.pathname.startsWith('/api/scores')) {
        const target = apiBase.replace(/\/$/, '') + u.pathname + u.search;
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) if (!HOP.test(k)) headers.set(k, v);
        headers.set('user-agent', 'raenest-agent/1.0');
        const body = (req.method === 'GET' || req.method === 'HEAD') ? undefined : await readBody(req);
        const up = await fetch(target, { method: req.method, headers, body, redirect: 'follow' });
        const outH = new Headers();
        up.headers.forEach((v, k) => { if (!SKIP_RESP.test(k)) outH.set(k, v); });
        outH.set('access-control-allow-origin', '*');
        outH.set('access-control-allow-methods', 'GET,POST,OPTIONS');
        outH.set('access-control-allow-headers', 'content-type');
        res.writeHead(up.status, [...outH.entries()]);
        return res.end(Buffer.from(await up.arrayBuffer()));
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    } catch (e) {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, code: 'proxy_error', detail: String(e.message || e) }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, hostname, () => { server.removeListener('error', reject); resolve(); });
  });
  note(`ready on http://${hostname}:${port}/ (html=${path.relative(root, htmlFile)}, api=${apiBase})`);
  return { port, hostname, url: `http://${hostname}:${port}/`, close: () => new Promise(r => server.close(r)) };
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  const port = process.env.PORT ? +process.env.PORT : (cfg.port || 8321);
  startServer({ port, apiBase: cfg.apiBase || 'https://fun.raenest.com' })
    .then(s => console.log(`[server] ready on ${s.url} — game at ${s.url}, leaderboard proxied via /api/scores`))
    .catch(e => { console.error('[server] failed to start:', e.message); process.exit(1); });
}
