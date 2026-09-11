import test from 'node:test';
import assert from 'node:assert/strict';
import { CURATED_REPLAYS, cloneCuratedReplay, curatedReplayById } from '../replay/library.ts';
import { validateReplay } from '../replay/validate.ts';
import { DEFAULT_REPLAY, DEFAULT_REPLAY_ID } from '../web/viewer-shell.ts';

test('the curated library contains attributed canonical replays with varied behavior', () => {
  assert.ok(CURATED_REPLAYS.length >= 3);
  assert.equal(new Set(CURATED_REPLAYS.map((entry) => entry.id)).size, CURATED_REPLAYS.length);
  for (const entry of CURATED_REPLAYS) {
    const validation = validateReplay(entry.replay);
    assert.equal(validation.ok, true, `${entry.id} should validate`);
    assert.equal(typeof entry.replay.metadata?.source, 'string');
    assert.equal(typeof entry.replay.metadata?.source_url, 'string');
    assert.ok(entry.description.length > 0);
  }
  assert.equal(CURATED_REPLAYS.some((entry) => entry.replay.moves.some((move) => move === 'e1g1')), true);
  assert.equal(CURATED_REPLAYS.some((entry) => entry.replay.moves.some((move) => move === 'e5d6')), true);
  assert.equal(CURATED_REPLAYS.some((entry) => entry.replay.metadata?.result === '0-1'), true);
});

test('curated lookup returns isolated replay copies', () => {
  assert.equal(curatedReplayById('missing'), null);
  const first = cloneCuratedReplay('opening');
  const second = cloneCuratedReplay('opening');
  assert.ok(first && second);
  first.moves[0] = 'd2d4';
  assert.equal(second.moves[0], 'e2e4');
});

test('the public viewer defaults to the first curated replay', () => {
  assert.equal(DEFAULT_REPLAY_ID, CURATED_REPLAYS[0].id);
  assert.deepEqual(DEFAULT_REPLAY.moves, CURATED_REPLAYS[0].replay.moves);
});
