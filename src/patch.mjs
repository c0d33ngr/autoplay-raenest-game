// patch.mjs — build out/raenest.patched.html from game/raenest.html + src/hook.js.
//
// The hook is injected at the tail of the game's main IIFE, right after the
// initial `requestAnimationFrame(frame);` call, so it shares the game's closure
// (state, lane, laneX, carX, carY, road, objs, score, dist, v, level, stops,
// coinsGot, shield, carrying, roleKey, cityKey, start, getBest, ...).
//
// Rebuild is idempotent: it always regenerates from the pristine game source.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = path.join(root, 'game', 'raenest.html');
const HOOK = path.join(root, 'src', 'hook.js');
const OUT = path.join(root, 'out', 'raenest.patched.html');

// Exact IIFE tail of game/raenest.html — must occur exactly once.
const ANCHOR = '      requestAnimationFrame(frame);\n    })();';

const html = fs.readFileSync(SRC, 'utf8');
if (html.includes('automation hook (injected)')) {
  console.error('patch.mjs: game/raenest.html already contains the hook; it must stay pristine. Restore it from the original source.');
  process.exit(1);
}
if (html.split(ANCHOR).length - 1 !== 1) {
  console.error('patch.mjs: IIFE-tail anchor not found (or found more than once). The upstream game HTML changed — locate the last `requestAnimationFrame(frame);` right before the IIFE `})();` in game/raenest.html and update ANCHOR here.');
  process.exit(1);
}
const hook = fs.readFileSync(HOOK, 'utf8').replace(/\n$/, '');
const out = html.replace(ANCHOR, '      requestAnimationFrame(frame);\n\n' + hook + '\n    })();');
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, out);
console.log(`patch.mjs: wrote ${path.relative(root, OUT)} (${out.length} bytes, +${out.length - html.length} from hook)`);
