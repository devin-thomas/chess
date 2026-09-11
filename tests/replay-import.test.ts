import assert from 'node:assert/strict';
import test from 'node:test';
import {
  choosePgnGame,
  parsePgnForViewer,
  pgnGameOptionLabel,
  pgnImportErrorMessage,
  validPgnGames,
} from '../web/replay-import.ts';
import { createReplayController } from '../replay/controller.ts';

test('viewer PGN import exposes valid and invalid games without selecting invalid data', () => {
  const collection = parsePgnForViewer('[White "Ready"]\n1. e4 *\n\n[White "Broken"]\n1. NotASan *');
  assert.equal(collection.games.length, 2);
  assert.equal(validPgnGames(collection).length, 1);

  const ready = choosePgnGame(collection, 0);
  assert.equal(ready.ok, true);
  if (ready.ok) assert.deepEqual(ready.replay.moves, ['e2e4']);

  const broken = choosePgnGame(collection, 1);
  assert.equal(broken.ok, false);
  if (!broken.ok) {
    assert.match(pgnImportErrorMessage(broken.error), /game 2/);
    assert.match(pgnGameOptionLabel(collection.games[1]), /unavailable/);
  }
});

test('viewer import helpers return cloned replay data for safe replacement', () => {
  const collection = parsePgnForViewer('1. e4 *');
  const choice = choosePgnGame(collection, 0);
  assert.equal(choice.ok, true);
  if (!choice.ok) return;
  choice.replay.moves[0] = 'e2e3';
  const secondChoice = choosePgnGame(collection, 0);
  assert.equal(secondChoice.ok, true);
  if (secondChoice.ok) assert.equal(secondChoice.replay.moves[0], 'e2e4');
});

test('an invalid imported game cannot replace the currently loaded replay', () => {
  const controller = createReplayController();
  assert.equal(controller.load({
    schema_version: 1,
    ruleset: 'orthodox-chess-v1',
    root: { kind: 'standard' },
    moves: ['e2e4'],
  }).ok, true);
  controller.stepForward();
  const before = controller.position();
  const collection = parsePgnForViewer('1. NotASan *');
  const choice = choosePgnGame(collection, 0);
  assert.equal(choice.ok, false);
  assert.deepEqual(controller.position(), before);
  assert.equal(controller.currentPly(), 1);
});
