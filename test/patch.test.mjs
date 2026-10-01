// patch.test.mjs — patcher: single-anchor injection, pristine-source guard,
// deterministic rebuild, plus a real CLI build against the repo's game/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { applyPatch, ANCHOR, HOOK_MARKER } from '../src/patch.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const hook = fs.readFileSync(path.join(root, 'src', 'hook.js'), 'utf8');

// Minimal synthetic game: an IIFE whose tail is the exact ANCHOR.
const clean =
  '<script>\n' +
  '  (function () {\n' +
  '    function frame() { /* game loop */ }\n' +
  ANCHOR + '\n' +
  '  </script>\n';

test('injects the shipped hook exactly once, at the IIFE tail', () => {
  const out = applyPatch(clean, hook);
  assert.equal(out.split(HOOK_MARKER).length - 1, 1);
  const positions = [out.indexOf('function frame()'), out.indexOf(HOOK_MARKER), out.lastIndexOf('})();')];
  assert.ok(
    positions[0] >= 0 && positions[0] < positions[1] && positions[1] < positions[2],
    'hook must sit between the game body and the IIFE close',
  );
});

test('is deterministic for a pristine source', () => {
  assert.equal(applyPatch(clean, hook), applyPatch(clean, hook));
});

test('refuses a source that already contains the hook', () => {
  assert.throws(() => applyPatch(applyPatch(clean, hook), hook), /pristine/);
});

test('refuses a source without the IIFE-tail anchor', () => {
  assert.throws(() => applyPatch('<script>(function(){})());</script>', hook), /anchor/i);
});

test('refuses a source where the anchor occurs more than once', () => {
  assert.throws(() => applyPatch(clean + clean, hook), /anchor/i);
});

test('CLI build regenerates out/raenest.patched.html from the real game', () => {
  const r = spawnSync(process.execPath, [path.join(root, 'src', 'patch.mjs')], { encoding: 'utf8' });
  assert.equal(r.status, 0, 'patch.mjs failed: ' + (r.stderr || r.stdout));
  assert.match(r.stdout, /wrote out\/raenest\.patched\.html/);
  const built = fs.readFileSync(path.join(root, 'out', 'raenest.patched.html'), 'utf8');
  assert.equal(built.split(HOOK_MARKER).length - 1, 1);
  assert.ok(built.includes('window.__forceCrash'));
});
