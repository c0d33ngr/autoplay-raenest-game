// post.mjs — post (or re-post) a finished run to the leaderboard directly,
// for when the run itself finished but the in-page post failed (e.g. network
// dropped at the moment of posting). Re-posting with the same fingerprint is
// safe: the server keeps the player's best.
//
// From a saved report (recommended — carries name/role/city/fingerprint/score):
//   node src/post.mjs --report out/report-<ts>-a1.json
// Or manually:
//   node src/post.mjs --score 451234 --name "c0d33ngr" --role freelancer --city lagos --fingerprint <id> [--api <base>]
// The fingerprint is the stable player id (localStorage rn-run-pid); it is in
// every play.mjs report under `fingerprint`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cfg = (() => { try { return JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')); } catch { return {}; } })();
const CLI = process.argv.slice(2);
const flag = n => { const i = CLI.indexOf('--' + n); return i === -1 ? undefined : CLI[i + 1]; };

let name, role, city, score, fingerprint, api;
if (flag('report')) {
  const rep = JSON.parse(fs.readFileSync(path.resolve(flag('report')), 'utf8'));
  if (!rep.config || rep.score == null) { console.error('post.mjs: report has no postable data (missing score/config)'); process.exit(1); }
  name = rep.config.name; role = rep.config.role; city = rep.config.city;
  score = rep.score; fingerprint = rep.fingerprint; api = rep.config.apiBase;
} else {
  name = flag('name') ?? cfg.name;
  role = flag('role') ?? cfg.role;
  city = flag('city') ?? cfg.city;
  score = flag('score') ? +flag('score') : undefined;
  fingerprint = flag('fingerprint');
  api = flag('api') ?? cfg.apiBase;
}
if (!api) api = 'https://fun.raenest.com';
if (!Number.isFinite(score) || score <= 0) { console.error('post.mjs: --score (or --report with a score) is required'); process.exit(1); }
if (!name || !role || !city) { console.error('post.mjs: name/role/city missing (use --report or full flags)'); process.exit(1); }
if (!fingerprint) {
  console.error('post.mjs: --fingerprint missing. It is the stable player id (localStorage rn-run-pid) and is stored in every play.mjs report under `fingerprint`.');
  process.exit(1);
}

const res = await fetch(`${api.replace(/\/$/, '')}/api/scores`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ fingerprint, name, role, city, score: Math.round(score) }),
});
const data = await res.json().catch(() => ({}));
console.log(JSON.stringify({ status: res.status, ...data }, null, 2));
if (!res.ok || !data.ok) {
  console.error(`post.mjs: FAILED (code=${data.code || 'unknown'}). Check the network / apiBase (${api}).`);
  process.exit(1);
}
console.log(`post.mjs: posted ${Math.round(score)} as ${name} (${role}/${city}) — player ${String(data.player_key || '').slice(0, 12)}…, rankToday=${data.rankToday ?? 'n/a'}`);
