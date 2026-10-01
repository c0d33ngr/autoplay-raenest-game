// patch.mjs — build out/raenest.patched.html from game/raenest.html + src/hook.js.
//
// The hook is injected at the tail of the game's main IIFE, right after the
// initial `requestAnimationFrame(frame);` call, so it shares the game's closure
// (state, lane, laneX, carX, carY, road, objs, score, dist, v, level, stops,
// coinsGot, shield, carrying, roleKey, cityKey, start, getBest, ...).
//
// Rebuild is idempotent: it always regenerates from the pristine game source.
// `applyPatch` is exported (pure) so the tests exercise the shipped logic;
// the CLI below wires it to the real files.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = path.join(root, 'game', 'raenest.html');
const HOOK = path.join(root, 'src', 'hook.js');
const OUT = path.join(root, 'out', 'raenest.patched.html');

// Exact IIFE tail of game/raenest.html — must occur exactly once.
export const ANCHOR = '      requestAnimationFrame(frame);\n    })();';
export const HOOK_MARKER = 'automation hook (injected)';

// Pure: inject the driver `hook` into the pristine game `html` text.
// Throws if the source is not pristine (hook already present) or if the
// IIFE-tail anchor is missing / duplicated (upstream changed).
export function applyPatch(html, hook) {
  if (html.includes(HOOK_MARKER)) {
    throw new Error('game source already contains the automation hook; it must stay pristine. Restore it from the original source.');
  }
  if (html.split(ANCHOR).length - 1 !== 1) {
    throw new Error('IIFE-tail anchor not found (or found more than once). The upstream game HTML changed — locate the last `requestAnimationFrame(frame);` right before the IIFE `})();` in game/raenest.html and update ANCHOR.');
  }
  return html.replace(ANCHOR, '      requestAnimationFrame(frame);\n\n' + hook.replace(/\n$/, '') + '\n    })();');
}

const html = fs.readFileSync(SRC, 'utf8');
try {
  const out = applyPatch(html, fs.readFileSync(HOOK, 'utf8'));
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, out);
  console.log(`patch.mjs: wrote ${path.relative(root, OUT)} (${out.length} bytes, +${out.length - html.length} from hook)`);
} catch (e) {
  console.error('patch.mjs: ' + e.message);
  process.exit(1);
}
