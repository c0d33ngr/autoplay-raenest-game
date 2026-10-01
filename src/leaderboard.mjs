// leaderboard.mjs — client for the Raenest leaderboard API + CLI.
//
// API:  GET {api}/api/scores?role=<role>&period=<today|week|all>&city=<city|all>
//       -> { rows: [ { player_key, name, city, score }, ... ] }  (best-first, one row per player)
// Roles: freelancer | remote | founder | spender
// Cities: lagos | abuja | accra | nairobi | cairo | manila
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROLES = ['freelancer', 'remote', 'founder', 'spender'];
export const CITIES = ['lagos', 'abuja', 'accra', 'nairobi', 'cairo', 'manila'];
export const PERIODS = ['today', 'week', 'all'];

export async function fetchBoard(apiBase, { role, period = 'all', city = 'all' } = {}) {
  if (!ROLES.includes(role)) throw new Error('bad role: ' + role);
  const q = new URLSearchParams({ role, period, city });
  const res = await fetch(`${apiBase.replace(/\/$/, '')}/api/scores?${q}`);
  if (!res.ok) throw new Error(`board GET ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data.rows)) throw new Error('board: unexpected payload ' + JSON.stringify(data).slice(0, 200));
  return data.rows
    .map(x => ({ player_key: x.player_key, name: String(x.name || ''), city: x.city, score: +x.score || 0 }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score);
}

export async function topScore(apiBase, role, period = 'all') {
  const rows = await fetchBoard(apiBase, { role, period });
  return rows.length ? rows[0].score : 0;
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const cfg = (() => { try { return JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')); } catch { return {}; } })();
  const api = process.env.RAENEST_API || cfg.apiBase || 'https://fun.raenest.com';
  const want = process.argv[2];
  const roles = want ? [want] : ROLES;
  (async () => {
    for (const role of roles) {
      const all = await fetchBoard(api, { role, period: 'all' }).catch(e => { console.error(`${role}: all-time: ${e.message}`); return []; });
      const today = await fetchBoard(api, { role, period: 'today' }).catch(e => { console.error(`${role}: today: ${e.message}`); return []; });
      console.log(`\n=== ${role} (api=${api}) ===`);
      console.log('all-time top 5:');
      (all.slice(0, 5) || ['  (empty)']).forEach(r => {
        if (typeof r === 'string') { console.log(r); return; }
        console.log(`  ${String(r.score).padStart(9)}  ${r.name} (${r.city})`);
      });
      console.log(`today top: ${today.length ? `${today[0].score} (${today[0].name}, ${today[0].city})` : '(none yet)'}`);
    }
  })().catch(e => { console.error('leaderboard.mjs:', e.message); process.exit(1); });
}
