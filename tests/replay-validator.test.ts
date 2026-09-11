import test from 'node:test';
import assert from 'node:assert/strict';
import { validateReplay } from '../replay/validate.ts';
import { createReplaySession, positionToFen, ReplayEngineError } from '../replay/engine.ts';
import type { Position } from '../replay/schema.ts';

const replay = (moves: string[], metadata?: Record<string, string>) => ({ schema_version: 1, ruleset: 'orthodox-chess-v1', root: { kind: 'standard' }, moves, ...(metadata ? { metadata } : {}) });
test('isolated validation preserves existing session and input', () => {
  const active = createReplaySession({ kind: 'standard' }); active.play('d2d4');
  const before = active.state(); const input = replay(['e2e4', 'e7e5', 'g1f3']); const copy = structuredClone(input);
  const result = validateReplay(input); assert.ok(result.ok);
  assert.equal(result.final_state.revision, 3); assert.equal(result.final_state.side_to_move, 'black');
  assert.deepEqual(result.final_state.board[21], { color: 'white', type: 'knight' });
  assert.equal(result.final_state.halfmove_clock, 1); assert.equal(result.final_state.fullmove_number, 2);
  assert.deepEqual(active.state(), before); assert.deepEqual(input, copy);
  result.root_state.board.fill(null); assert.equal(active.state().board[4]?.type, 'king');
});
test('move failures retain exact executed location and authoritative state', () => {
  for (const [move, underlying] of [['e4e6', 'E_PATH_BLOCKED'], ['bad', 'E_INVALID_MOVE_SYNTAX']]) {
    const result = validateReplay(replay(['e2e4', 'e7e5', move])); assert.equal(result.ok, false); if (result.ok) return;
    assert.equal(result.error.code, 'E_REPLAY_MOVE'); assert.equal(result.error.move_index, 2);
    assert.equal(result.error.ply, 3); assert.equal(result.error.last_valid_ply, 2);
    assert.deepEqual(result.error.last_valid_state?.moves, ['e2e4', 'e7e5']);
    assert.equal(result.error.underlying_error?.code, underlying);
  }
});
test('terminal rules results take precedence over descriptive results', () => {
  const mate = ['f2f3', 'e7e5', 'g2g4', 'd8h4'];
  const result = validateReplay(replay(mate, { result: '1-0' })); assert.ok(result.ok);
  assert.equal(result.final_state.outcome?.result, '0-1'); assert.equal(result.diagnostics.length, 1);
  assert.equal(result.replay.metadata?.result, '1-0');
  const rejected = validateReplay(replay([...mate, 'a2a3'])); assert.equal(rejected.ok, false); if (rejected.ok) return;
  assert.equal(rejected.error.underlying_error?.code, 'E_GAME_OVER'); assert.equal(rejected.error.last_valid_ply, 4);
  const recorded = validateReplay(replay(['e2e4'], { result: '1-0' })); assert.ok(recorded.ok);
  assert.equal(recorded.final_state.status, 'active'); assert.deepEqual(recorded.diagnostics, []);
});
test('canonical root round trip retains counters, rights and en passant', () => {
  const session = createReplaySession({ kind: 'standard' }); const state = session.play('e2e4');
  const p: Position = { board: state.board, side_to_move: state.side_to_move, castling_rights: state.castling_rights,
    en_passant_target: state.en_passant_target, halfmove_clock: state.halfmove_clock, fullmove_number: state.fullmove_number };
  assert.equal(positionToFen(p), 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1');
  const result = validateReplay({ ...replay(['e7e5']), root: { kind: 'position', position: p } }); assert.ok(result.ok);
  for (const key of Object.keys(p) as (keyof Position)[]) assert.deepEqual(result.root_state[key], p[key]);
  assert.deepEqual(result.root_state.moves, []); assert.equal(Object.values(result.root_state.repetition_counts)[0], 1);
  p.board[4] = null;
  const invalid = validateReplay({ ...replay([]), root: { kind: 'position', position: p } }); assert.equal(invalid.ok, false); if (invalid.ok) return;
  assert.equal(invalid.error.code, 'E_REPLAY_ROOT'); assert.equal(invalid.error.underlying_error?.code, 'E_INVALID_FEN');
  assert.equal(invalid.error.move_index, null); assert.equal(invalid.error.last_valid_state, null);
});
test('bridge errors do not mutate session and response snapshots are independent', () => {
  const session = createReplaySession({ kind: 'standard' }); const before = session.state();
  assert.throws(() => session.play('e2e5'), ReplayEngineError); assert.deepEqual(session.state(), before);
  const legal = session.legalMoves(); assert.equal(legal.length, 20); legal.length = 0;
  assert.equal(session.legalMoves().length, 20); before.board.fill(null); assert.equal(session.state().board[4]?.type, 'king');
});
