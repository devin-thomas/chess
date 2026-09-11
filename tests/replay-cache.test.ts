import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createReplayController } from '../replay/controller.ts';
import type { Replay } from '../replay/schema.ts';

const shared = new URL('../shared/', import.meta.url);
const fixture = (id: string): Replay =>
  JSON.parse(readFileSync(new URL(`replay-fixtures/${id}.json`, shared), 'utf8')) as Replay;

const equivalenceFixtures = ['opening', 'castle-kingside', 'en-passant', 'repetition', 'seventy-five-move'];

test('cached and uncached seeks produce identical authoritative and presentation state', () => {
  for (const id of equivalenceFixtures) {
    const replay = fixture(id);
    const cached = createReplayController({ cache: 'full' });
    const uncached = createReplayController({ cache: false });
    assert.equal(cached.load(replay).ok, true, `${id} cached load`);
    assert.equal(uncached.load(replay).ok, true, `${id} uncached load`);
    const order = [...Array(replay.moves.length + 1).keys()].reverse()
      .concat([...Array(replay.moves.length + 1).keys()].filter((ply) => ply % 2 === 0));
    for (const ply of order) {
      assert.equal(cached.seek(ply).ok, true, `${id} cached seek ${ply}`);
      assert.equal(uncached.seek(ply).ok, true, `${id} uncached seek ${ply}`);
      assert.deepEqual(cached.position(), uncached.position(), `${id} authoritative state at ${ply}`);
      assert.deepEqual(cached.presentationSnapshot()?.pieces, uncached.presentationSnapshot()?.pieces,
        `${id} presentation identity at ${ply}`);
      assert.deepEqual(cached.presentationSnapshot()?.rule_state, uncached.presentationSnapshot()?.rule_state,
        `${id} presentation rules state at ${ply}`);
    }
  }
});

test('cached seek preserves repetition termination when playback continues', () => {
  const replay = fixture('repetition');
  const cached = createReplayController();
  const uncached = createReplayController({ cache: false });
  assert.equal(cached.load(replay).ok, true);
  assert.equal(uncached.load(replay).ok, true);
  assert.equal(cached.seek(15).ok, true);
  assert.equal(uncached.seek(15).ok, true);
  assert.equal(cached.stepForward().ok, true);
  assert.equal(uncached.stepForward().ok, true);
  assert.deepEqual(cached.position(), uncached.position());
  assert.equal(cached.position()?.outcome?.reason, 'fivefold_repetition');
});

test('a successful load invalidates the previous full-history cache', () => {
  const controller = createReplayController({ cache: 'full' });
  assert.equal(controller.load(fixture('opening')).ok, true);
  assert.deepEqual(controller.cacheStats(), {
    mode: 'full', entries: 4, hits: 0, misses: 0, builds: 1, lastSeek: null,
  });
  assert.equal(controller.seek(3).ok, true);
  assert.equal(controller.cacheStats().hits, 1);
  assert.equal(controller.load(fixture('castle-kingside')).ok, true);
  assert.equal(controller.cacheStats().entries, fixture('castle-kingside').moves.length + 1);
  assert.equal(controller.cacheStats().builds, 2);
  assert.equal(controller.currentPly(), 0);
  assert.equal(controller.length(), fixture('castle-kingside').moves.length);
  assert.equal(controller.seek(controller.length()).ok, true);
  assert.equal(controller.position()?.board[6]?.type, 'king');
});

test('cached state snapshots do not expose mutable cache storage', () => {
  const controller = createReplayController({ cache: 'full' });
  assert.equal(controller.load(fixture('opening')).ok, true);
  const state = controller.position();
  assert.ok(state);
  state.board.fill(null);
  assert.equal(controller.seek(0).ok, true);
  assert.equal(controller.position()?.board[4]?.type, 'king');
});

test('the default controller remains an observable uncached reference path', () => {
  const controller = createReplayController();
  assert.equal(controller.cacheMode(), 'none');
  assert.equal(controller.load(fixture('opening')).ok, true);
  assert.equal(controller.seek(2).ok, true);
  assert.equal(controller.cacheStats().entries, 0);
  assert.equal(controller.lastSeekTiming()?.cacheHit, false);
});
