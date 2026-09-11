import test from 'node:test';
import assert from 'node:assert/strict';
import { importPgn } from '../replay/pgn-import.ts';
import { buildReplayMoveList } from '../web/replay-move-list.ts';

function replayFromPgn(source: string) {
  const replay = importPgn(source);
  assert.equal('moves' in replay, true);
  if (!('moves' in replay)) throw new Error('Expected a single imported replay');
  return replay;
}

test('move list derives SAN and preserves standard move-number context', () => {
  const entries = buildReplayMoveList(replayFromPgn('1. e4 e5 2. Nf3 Nc6 *'));
  assert.deepEqual(entries.map(entry => entry.san), ['e4', 'e5', 'Nf3', 'Nc6']);
  assert.deepEqual(entries.map(entry => entry.notation), ['1. e4', '1... e5', '2. Nf3', '2... Nc6']);
  assert.deepEqual(entries.map(entry => entry.ply), [1, 2, 3, 4]);
});

test('move list uses the root fullmove and side for black-to-move games', () => {
  const replay = replayFromPgn('[SetUp "1"]\n[FEN "4k3/8/8/8/8/8/8/4K2R b - - 0 17"]\n17... Kd7 *');
  const entries = buildReplayMoveList(replay);
  assert.deepEqual(entries.map(entry => entry.notation), ['17... Kd7']);
  assert.equal(entries[0].side, 'black');
});

test('move list includes authoritative special-move SAN suffixes', () => {
  const castle = replayFromPgn('[SetUp "1"]\n[FEN "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1"]\n1. O-O O-O-O *');
  assert.deepEqual(buildReplayMoveList(castle).map(entry => entry.san), ['O-O', 'O-O-O']);

  const promotion = replayFromPgn('[SetUp "1"]\n[FEN "k7/4P3/8/8/8/8/8/4K3 w - - 0 1"]\n1. e8=Q+ *');
  assert.equal(buildReplayMoveList(promotion)[0].san, 'e8=Q+');
});
