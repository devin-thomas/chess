import test from 'node:test';
import assert from 'node:assert/strict';
import { importPgn, importPgnCollection, PgnImportError } from '../replay/pgn-import.ts';

function errorOf(action: () => unknown, code: string): PgnImportError {
  assert.throws(action, error => error instanceof PgnImportError && error.code === code);
  try { action(); } catch (error) { return error as PgnImportError; }
  throw new Error('expected action to throw');
}

test('imports tags and a known mainline into canonical moves', () => {
  const replay = importPgn('[Event "Test"]\n[White "Alice"]\n[Black "Bob"]\n[Result "1-0"]\n\n1. e4 e5 2. Nf3 Nc6 1-0');
  assert.equal('moves' in replay, true);
  if (!('moves' in replay)) return;
  assert.deepEqual(replay.moves, ['e2e4', 'e7e5', 'g1f3', 'b8c6']);
  assert.deepEqual(replay.metadata, { event: 'Test', white: 'Alice', black: 'Bob', result: '1-0' });
});

test('resolves castling, promotion, and black-to-move FEN roots', () => {
  const castle = importPgn('[SetUp "1"]\n[FEN "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1"]\n1. O-O O-O-O *');
  assert.equal('moves' in castle, true);
  if ('moves' in castle) assert.deepEqual(castle.moves, ['e1g1', 'e8c8']);
  const promotion = importPgn('[SetUp "1"]\n[FEN "k7/4P3/8/8/8/8/8/4K3 w - - 0 1"]\n1. e8=Q+ *');
  assert.equal('moves' in promotion, true);
  if ('moves' in promotion) assert.deepEqual(promotion.moves, ['e7e8q']);
  const black = importPgn('[SetUp "1"]\n[FEN "4k3/8/8/8/8/8/8/4K2R b - - 0 17"]\n17... Kd7 *');
  assert.equal('moves' in black, true);
  if ('moves' in black) {
    assert.deepEqual(black.root.kind, 'position');
    if (black.root.kind === 'position') { assert.equal(black.root.position.side_to_move, 'black'); assert.equal(black.root.position.fullmove_number, 17); }
    assert.deepEqual(black.moves, ['e8d7']);
  }
});

test('skips comments, NAGs, and recursive balanced variations', () => {
  const replay = importPgn('1. e4 {main} $1 (1. d4 (1... d5) 1... Nf6) e5 ; trailing\n2. Nf3 *');
  assert.equal('moves' in replay, true);
  if ('moves' in replay) assert.deepEqual(replay.moves, ['e2e4', 'e7e5', 'g1f3']);
});

test('returns chooser data and keeps invalid games visibly invalid', () => {
  const collection = importPgnCollection('[White "Good"]\n1. e4 *\n\n[White "Bad"]\n1. NotASan *');
  assert.equal(collection.games.length, 2);
  assert.equal(collection.choices, collection.games);
  assert.equal(collection.games[0].replay?.moves[0], 'e2e4');
  assert.equal(collection.games[1].replay, null);
  assert.equal(collection.games[1].error?.code, 'E_REPLAY_IMPORT');
});

test('reports malformed syntax, illegal SAN, conflicts, and unsupported variants with context', () => {
  const illegal = errorOf(() => importPgn('1. e5'), 'E_REPLAY_IMPORT');
  assert.equal(illegal.location?.line, 1);
  assert.equal(illegal.location?.column, 4);
  const unbalanced = errorOf(() => importPgn('1. e4 (1. d4'), 'E_REPLAY_IMPORT');
  assert.match(unbalanced.message, /Unbalanced/);
  errorOf(() => importPgn('[Variant "Chess960"]\n1. e4 *'), 'E_REPLAY_IMPORT');
  errorOf(() => importPgn('[Result "1-0"]\n1. e4 0-1'), 'E_REPLAY_IMPORT');
  errorOf(() => importPgn('[SetUp "1"]\n1. e4 *'), 'E_REPLAY_IMPORT');
});

test('enforces PGN input, collection, metadata, ply, and variation limits', () => {
  const tooManyGames = Array.from({ length: 101 }, () => '1. e4 *').join('\n');
  assert.equal(errorOf(() => importPgn(tooManyGames), 'E_REPLAY_LIMIT').limit, 'games:100');
  assert.equal(errorOf(() => importPgn(`[Event "${'x'.repeat(1025)}"]\n1. e4 *`), 'E_REPLAY_LIMIT').limit, 'metadata_string_code_points:1024');
  const tooDeep = `${'('.repeat(33)}1. e4${')'.repeat(33)}`;
  assert.equal(errorOf(() => importPgn(tooDeep), 'E_REPLAY_LIMIT').limit, 'variation_depth:32');
  const tooManyPlies = `1. ${Array.from({ length: 4097 }, () => 'e4').join(' ')}`;
  assert.equal(errorOf(() => importPgn(tooManyPlies), 'E_REPLAY_LIMIT').limit, 'plies:4096');
  const tooLarge = 'x'.repeat(5 * 1024 * 1024 + 1);
  assert.equal(errorOf(() => importPgn(tooLarge), 'E_REPLAY_LIMIT').limit, 'input_bytes:5242880');
});
