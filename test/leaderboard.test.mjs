// leaderboard.test.mjs — board client: normalization, sorting, zero-score
// filtering and error paths, with a stubbed global fetch (no network).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { fetchBoard, topScore } from '../src/leaderboard.mjs';

const origFetch = globalThis.fetch;
after(() => { globalThis.fetch = origFetch; });

function stub(payload, { ok = true, status = 200 } = {}) {
  const calls = [];
  globalThis.fetch = async url => {
    calls.push(String(url));
    return { ok, status, json: async () => payload };
  };
  return calls;
}

const ROWS = {
  rows: [
    { player_key: 'p2', name: 'B', city: 'lagos', score: '120' },
    { player_key: 'p1', name: 'A', city: 'abuja', score: 300 },
    { player_key: 'p3', name: 'C', city: 'lagos', score: 0 },
    { player_key: 'p4', name: 'D', city: 'nairobi', score: 5 },
  ],
};

test('normalizes rows: string scores coerced, zero scores dropped, best-first order', async () => {
  const calls = stub(ROWS);
  const rows = await fetchBoard('https://fun.raenest.com', { role: 'freelancer', period: 'all', city: 'all' });
  assert.deepEqual(rows.map(r => [r.name, r.score]), [['A', 300], ['B', 120], ['D', 5]]);
  assert.equal(rows[0].player_key, 'p1');
  assert.equal(calls[0], 'https://fun.raenest.com/api/scores?role=freelancer&period=all&city=all');
});

test('tolerates a trailing slash on apiBase', async () => {
  const calls = stub(ROWS);
  await fetchBoard('https://fun.raenest.com/', { role: 'remote' });
  assert.match(calls[0], /^https:\/\/fun\.raenest\.com\/api\/scores\?role=remote/);
});

test('rejects an unknown role before hitting the network', async () => {
  const calls = stub(ROWS);
  await assert.rejects(() => fetchBoard('https://x.test', { role: 'ghost' }), /bad role/);
  assert.equal(calls.length, 0);
});

test('throws on a non-OK response', async () => {
  stub(ROWS, { ok: false, status: 500 });
  await assert.rejects(() => fetchBoard('https://x.test', { role: 'remote' }), /board GET 500/);
});

test('throws on an unexpected payload shape', async () => {
  stub({ rows: 'nope' });
  await assert.rejects(() => fetchBoard('https://x.test', { role: 'remote' }), /unexpected payload/);
});

test('topScore returns the best row, or 0 for an empty board', async () => {
  stub(ROWS);
  assert.equal(await topScore('https://x.test', 'founder', 'all'), 300);
  stub({ rows: [] });
  assert.equal(await topScore('https://x.test', 'founder', 'all'), 0);
});
