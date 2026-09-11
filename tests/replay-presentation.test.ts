import test from 'node:test';
import assert from 'node:assert/strict';
import { createReplaySession } from '../replay/engine.ts';
import { createPresentationAdapter } from '../replay/presentation.ts';
import type { ReconstructionTransition } from '../replay/presentation.ts';
import type { Piece, ReplayRoot } from '../replay/schema.ts';

function setup(placements: Record<string, Piece>, rights: Partial<{
  white_kingside: boolean; white_queenside: boolean; black_kingside: boolean; black_queenside: boolean;
}> = {}, ep: string | null = null, side: 'white' | 'black' = 'white'): ReplayRoot {
  const board: (Piece | null)[] = Array(64).fill(null);
  for (const [square, piece] of Object.entries(placements)) {
    board[square.charCodeAt(0) - 97 + (Number(square[1]) - 1) * 8] = piece;
  }
  return { kind: 'position', position: { board, side_to_move: side,
    castling_rights: { white_kingside: false, white_queenside: false,
      black_kingside: false, black_queenside: false, ...rights },
    en_passant_target: ep, halfmove_clock: 0, fullmove_number: 1 } };
}

const white = (type: Piece['type']): Piece => ({ color: 'white', type });
const black = (type: Piece['type']): Piece => ({ color: 'black', type });

function playback(root: ReplayRoot, moves: readonly string[]) {
  const session = createReplaySession(root);
  const rootState = session.state();
  const adapter = createPresentationAdapter();
  const initial = adapter.reset(rootState, session.legalMoves());
  const transitions: ReconstructionTransition[] = [];
  const updates = moves.map((move, i) => {
    const before = session.state();
    const after = session.play(move);
    transitions.push({ move, before, after, ply: i + 1 });
    return adapter.advance(move, before, after, i + 1, { legalMoves: session.legalMoves() });
  });
  return { session, rootState, adapter, initial, transitions, updates };
}

test('ordinary movement and capture preserve and retire root-allocated identities', () => {
  const run = playback({ kind: 'standard' }, ['e2e4', 'd7d5', 'e4d5']);
  const pawn = run.initial.snapshot.pieces.find(piece => piece.board_square === 'e2')!;
  const captured = run.initial.snapshot.pieces.find(piece => piece.board_square === 'd7')!;
  const update = run.updates[2];
  assert.equal(update.transition?.piece_identity, pawn.piece_identity);
  assert.deepEqual(update.transition?.captured, { piece_identity: captured.piece_identity, square: 'd5' });
  assert.deepEqual(update.events.map(event => event.kind), ['move_accepted', 'capture']);
  assert.equal(update.snapshot.pieces.length, 31);
  assert.ok(!update.snapshot.pieces.some(piece => piece.piece_identity === captured.piece_identity));
  assert.equal(update.snapshot.rules_revision, 3);
  assert.equal(update.transition?.revision_before, 2);
});

for (const [move, rookFrom, rookTo] of [['e1g1', 'h1', 'f1'], ['e1c1', 'a1', 'd1']]) {
  test(`${move} explicitly identifies both castling pieces`, () => {
    const root = setup({ e1: white('king'), a1: white('rook'), h1: white('rook'), e8: black('king') },
      { white_kingside: true, white_queenside: true });
    const run = playback(root, [move]);
    const rook = run.initial.snapshot.pieces.find(piece => piece.board_square === rookFrom)!;
    assert.deepEqual(run.updates[0].transition?.castling_rook,
      { piece_identity: rook.piece_identity, from: rookFrom, to: rookTo });
    assert.deepEqual(run.updates[0].events.map(event => event.kind), ['move_accepted', 'castling']);
  });
}

test('en passant includes the removed pawn square and authoritative effective target', () => {
  const run = playback({ kind: 'standard' }, ['e2e4', 'a7a6', 'e4e5', 'd7d5', 'e5d6']);
  assert.equal(run.updates[0].snapshot.raw_en_passant_target, 'e3');
  assert.equal(run.updates[0].snapshot.effective_en_passant_target, null);
  assert.equal(run.updates[3].snapshot.effective_en_passant_target, 'd6');
  assert.equal(run.updates[4].transition?.captured?.square, 'd5');
  assert.equal(run.updates[4].transition?.en_passant_capture_square, 'd5');
  assert.deepEqual(run.updates[4].events.map(event => event.kind), ['move_accepted', 'en_passant']);
});

test('a pinned pawn does not make the raw en passant target effective', () => {
  const root = setup({ e1: white('king'), e5: white('pawn'), d5: black('pawn'),
    e8: black('rook'), a8: black('king') }, {}, 'd6');
  const run = playback(root, []);
  assert.equal(run.initial.snapshot.raw_en_passant_target, 'd6');
  assert.equal(run.initial.snapshot.effective_en_passant_target, null);
});

test('capture-promotion preserves pawn identity and orders capture before promotion and check', () => {
  const root = setup({ a1: white('king'), g7: white('pawn'), a8: black('king'), h8: black('rook') });
  const run = playback(root, ['g7h8q']);
  const pawn = run.initial.snapshot.pieces.find(piece => piece.board_square === 'g7')!;
  const update = run.updates[0];
  assert.equal(update.transition?.piece_identity, pawn.piece_identity);
  assert.equal(update.transition?.original_type, 'pawn');
  assert.equal(update.transition?.promotion, 'queen');
  assert.deepEqual(update.events.map(event => event.kind), ['move_accepted', 'capture', 'promotion', 'check']);
  assert.equal(update.snapshot.pieces.find(piece => piece.piece_identity === pawn.piece_identity)?.piece_type, 'queen');
});

test('quiet underpromotion can end in authoritative draw', () => {
  const root = setup({ a1: white('king'), g7: white('pawn'), a8: black('king') });
  const run = playback(root, ['g7g8n']);
  assert.deepEqual(run.updates[0].events.map(event => event.kind), ['move_accepted', 'promotion', 'draw']);
  assert.equal(run.updates[0].events.at(-1)?.outcome?.reason, 'dead_position');
});

test('terminal projections order check before checkmate and distinguish stalemate', () => {
  const mate = playback({ kind: 'standard' }, ['f2f3', 'e7e5', 'g2g4', 'd8h4']);
  assert.deepEqual(mate.updates[3].events.map(event => event.kind), ['move_accepted', 'check', 'checkmate']);
  const stale = playback(setup({ c6: white('king'), c7: white('queen'), a8: black('king') }), ['c7b6']);
  assert.deepEqual(stale.updates[0].events.map(event => event.kind), ['move_accepted', 'stalemate']);
});

test('arbitrary seek rebuilds identity history, discards animation, and preserves delivery ordering', () => {
  const run = playback({ kind: 'standard' }, ['e2e4', 'd7d5', 'e4d5', 'd8d5']);
  const lastSequence = run.updates.at(-1)!.events.at(-1)!.event_sequence;
  const firstSeek = run.adapter.reconstruct(run.rootState, run.transitions.slice(0, 2));
  const secondSeek = run.adapter.reconstruct(run.rootState, run.transitions);
  assert.deepEqual(firstSeek.snapshot.pieces, run.updates[1].snapshot.pieces);
  assert.deepEqual(secondSeek.snapshot.pieces, run.updates[3].snapshot.pieces);
  assert.deepEqual(secondSeek.snapshot.rule_state, run.updates[3].snapshot.rule_state);
  assert.equal(firstSeek.events.length, 1);
  assert.equal(secondSeek.events.length, 1);
  assert.equal(secondSeek.events[0].kind, 'state_reset_or_load');
  assert.equal(secondSeek.events[0].event_sequence, lastSequence + 2);
  assert.equal(secondSeek.snapshot.state_epoch, 3);
  assert.equal(secondSeek.transition, null);
  assert.equal(secondSeek.snapshot.active_animation, null);
});

test('presentation output is deeply immutable and does not freeze caller-owned rules state', () => {
  const run = playback({ kind: 'standard' }, ['e2e4']);
  const update = run.updates[0];
  assert.ok(Object.isFrozen(update.snapshot.pieces[0]));
  assert.ok(Object.isFrozen(update.snapshot.rule_state.board));
  assert.ok(Object.isFrozen(update.events[0].move_record));
  assert.ok(!Object.isFrozen(run.transitions[0].after));
  assert.equal(run.initial.snapshot.pieces.find(piece => piece.board_square === 'e2')?.piece_type, 'pawn');
});
