import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReplay, ReplayError } from '../replay/schema.ts';
import { createReplaySession } from '../replay/engine.ts';

const sample = () => ({ schema_version: 1, ruleset: 'orthodox-chess-v1', root: { kind: 'standard' }, moves: ['e2e4', 'e7e5', 'g1f3'] });
function rejects(value: unknown, code = 'E_REPLAY_SCHEMA') {
  assert.throws(() => parseReplay(value), error => error instanceof ReplayError && error.code === code && error.last_valid_state === null);
}
test('standard replay accepts JSON text and owns nested metadata', () => {
  const source = { ...sample(), metadata: { white: null, white_rating: 0, result: '*', custom: { values: ['hello'] } } };
  const replay = parseReplay(source);
  source.metadata.custom.values.push('changed');
  assert.deepEqual(replay.metadata?.custom, { values: ['hello'] });
  assert.deepEqual(parseReplay(JSON.stringify(sample())), sample());
  assert.deepEqual(parseReplay({ ...sample(), moves: [] }).moves, []);
});
test('strict top-level, version, ruleset, roots and move types', () => {
  for (const value of [null, [], {}, { ...sample(), extra: 1 }, { ...sample(), schema_version: 2 },
    { ...sample(), ruleset: null }, { ...sample(), root: { kind: 'standard', fen: 'x' } },
    { ...sample(), root: { kind: 'fen' } }, { ...sample(), moves: ['E2e4'] }, { ...sample(), moves: [null] },
    { ...sample(), moves: Array(1) }, '{']) rejects(value);
  rejects({ ...sample(), ruleset: 'chess960' }, 'E_REPLAY_RULESET');
});
test('metadata validates known fields and rejects non-JSON values', () => {
  for (const metadata of [null, [], { white: 1 }, { black_rating: -1 }, { white_rating: 1.1 },
    { result: null }, { result: ['*'] }, { custom: undefined }, { custom: NaN }, { custom: new Date() }]) rejects({ ...sample(), metadata });
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  rejects({ ...sample(), metadata: cycle });
});
test('canonical positions validate every field and normalize the standard root', () => {
  const state = createReplaySession({ kind: 'standard' }).state();
  const { board, side_to_move, castling_rights, en_passant_target, halfmove_clock, fullmove_number } = state;
  const p = { board, side_to_move, castling_rights, en_passant_target, halfmove_clock, fullmove_number };
  const rooted = (position: unknown) => ({ ...sample(), root: { kind: 'position', position } });
  assert.deepEqual(parseReplay(rooted(p)).root, { kind: 'standard' });
  for (const position of [{ ...p, extra: true }, { ...p, board: board.slice(1) }, { ...p, board: Array(64) },
    { ...p, board: [{ color: 'white', type: 'rook', id: 1 }, ...board.slice(1)] },
    { ...p, side_to_move: 'red' }, { ...p, castling_rights: { ...castling_rights, extra: false } },
    { ...p, castling_rights: { ...castling_rights, white_kingside: 1 } }, { ...p, en_passant_target: 'A3' },
    { ...p, halfmove_clock: -1 }, { ...p, fullmove_number: 0 }, { ...p, fullmove_number: Number.MAX_SAFE_INTEGER + 1 }]) rejects(rooted(position));
});
test('ingestion limits accept boundaries and reject oversized input with named limits', () => {
  assert.equal(parseReplay({ ...sample(), moves: Array(4096).fill('e2e4') }).moves.length, 4096);
  rejects({ ...sample(), moves: Array(4097).fill('e2e4') }, 'E_REPLAY_LIMIT');
  const metadata = Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`field${i}`, 'x']));
  parseReplay({ ...sample(), metadata });
  rejects({ ...sample(), metadata: { ...metadata, extra: 'x' } }, 'E_REPLAY_LIMIT');
  parseReplay({ ...sample(), metadata: { white: '\u{1f600}'.repeat(1024) } });
  rejects({ ...sample(), metadata: { white: '\u{1f600}'.repeat(1025) } }, 'E_REPLAY_LIMIT');
  let nested: unknown = null;
  for (let i = 0; i < 40; i++) nested = { nested };
  rejects({ ...sample(), metadata: { nested } }, 'E_REPLAY_LIMIT');
  const json = JSON.stringify(sample());
  parseReplay(json + ' '.repeat(5 * 1024 * 1024 - json.length));
  assert.throws(() => parseReplay(json + ' '.repeat(5 * 1024 * 1024)), error => error instanceof ReplayError && error.code === 'E_REPLAY_LIMIT' && error.limit === 'input_bytes:5242880');
  rejects(Object.assign(new Date(), sample()));
});
