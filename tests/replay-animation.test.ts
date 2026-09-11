import assert from 'node:assert/strict';
import test from 'node:test';
import { createReplayController } from '../replay/controller.ts';
import type { MoveRecord, PresentationSnapshot } from '../replay/presentation.ts';
import type { Piece, ReplayRoot } from '../replay/schema.ts';
import {
  CAPTURE_END_PROGRESS,
  PROMOTION_START_PROGRESS,
  createReplayAnimationModel,
  createReplayAnimationPlan,
} from '../web/replay-animation.ts';

function transitionFor(root: ReplayRoot, move: string): {
  before: PresentationSnapshot;
  after: PresentationSnapshot;
  transition: MoveRecord;
} {
  const controller = createReplayController();
  assert.equal(controller.load({
    schema_version: 1,
    ruleset: 'orthodox-chess-v1',
    root,
    moves: [move],
  }).ok, true);
  const before = controller.presentationSnapshot();
  assert.ok(before);
  assert.equal(controller.stepForward().ok, true);
  const after = controller.presentationSnapshot();
  const transition = controller.lastTransition();
  assert.ok(after);
  assert.ok(transition);
  return { before, after, transition };
}

function position(placements: Record<string, Piece>,
  rights: Partial<Record<'white_kingside' | 'white_queenside' | 'black_kingside' | 'black_queenside', boolean>> = {},
  enPassantTarget: string | null = null): ReplayRoot {
  const board = Array(64).fill(null) as (Piece | null)[];
  for (const [square, piece] of Object.entries(placements)) {
    board[square.charCodeAt(0) - 97 + (Number(square[1]) - 1) * 8] = piece;
  }
  return {
    kind: 'position',
    position: {
      board,
      side_to_move: 'white',
      castling_rights: {
        white_kingside: false,
        white_queenside: false,
        black_kingside: false,
        black_queenside: false,
        ...rights,
      },
      en_passant_target: enPassantTarget,
      halfmove_clock: 0,
      fullmove_number: 1,
    },
  };
}

const white = (type: 'king' | 'queen' | 'rook' | 'bishop' | 'knight' | 'pawn') => ({ color: 'white' as const, type });
const black = (type: 'king' | 'queen' | 'rook' | 'bishop' | 'knight' | 'pawn') => ({ color: 'black' as const, type });

test('ordinary moves expose one ordered move effect and transient interpolation', () => {
  const run = transitionFor({ kind: 'standard' }, 'e2e4');
  const plan = createReplayAnimationPlan(run.before, run.after, run.transition);
  assert.deepEqual(plan.effects.map((effect) => effect.kind), ['move']);
  const middle = plan.frame(0.5);
  const pawn = middle.pieces.find((piece) => piece.piece_identity === run.transition.piece_identity);
  assert.deepEqual(pawn?.position, { kind: 'interpolated', from: 'e2', to: 'e4', progress: 0.5 });
  assert.equal(pawn?.visible, true);
  assert.equal(plan.frame(1).settled, true);
  assert.deepEqual(plan.frame(1).pieces, run.after.pieces.map((piece) => ({
    piece_identity: piece.piece_identity,
    piece_type: piece.piece_type,
    color: piece.color,
    visual_asset_id: piece.visual_asset_id,
    position: { kind: 'square', square: piece.board_square },
    visible: true,
  })));
});

test('captures remove the captured identity after the deterministic capture phase', () => {
  const captureRun = (() => {
    const controller = createReplayController();
    assert.equal(controller.load({ schema_version: 1, ruleset: 'orthodox-chess-v1', root: { kind: 'standard' }, moves: ['e2e4', 'd7d5', 'e4d5'] }).ok, true);
    assert.equal(controller.seek(2).ok, true);
    const before = controller.presentationSnapshot()!;
    assert.equal(controller.stepForward().ok, true);
    return { before, after: controller.presentationSnapshot()!, transition: controller.lastTransition()! };
  })();
  const plan = createReplayAnimationPlan(captureRun.before, captureRun.after, captureRun.transition);
  assert.deepEqual(plan.effects.map((effect) => effect.kind), ['move', 'capture']);
  const capturedId = captureRun.transition.captured!.piece_identity;
  assert.equal(plan.frame(CAPTURE_END_PROGRESS / 2).pieces.find((piece) => piece.piece_identity === capturedId)?.visible, true);
  assert.equal(plan.frame(CAPTURE_END_PROGRESS).pieces.find((piece) => piece.piece_identity === capturedId)?.visible, false);
  assert.equal(plan.frame(1).pieces.some((piece) => piece.piece_identity === capturedId), false);
});

test('castling, en passant, and promotion expose explicit effects in stable order', () => {
  const castle = transitionFor(position({ e1: white('king'), h1: white('rook'), e8: black('king') }, { white_kingside: true }), 'e1g1');
  const castlePlan = createReplayAnimationPlan(castle.before, castle.after, castle.transition);
  assert.deepEqual(castlePlan.effects.map((effect) => effect.kind), ['move', 'castling']);
  const rookEffect = castlePlan.effects[1];
  assert.equal(rookEffect.kind, 'castling');
  assert.deepEqual(castlePlan.frame(0.5).pieces.find((piece) => piece.piece_identity === rookEffect.piece_identity)?.position,
    { kind: 'interpolated', from: 'h1', to: 'f1', progress: 0.5 });

  const enPassant = (() => {
    const controller = createReplayController();
    assert.equal(controller.load({ schema_version: 1, ruleset: 'orthodox-chess-v1', root: { kind: 'standard' }, moves: ['e2e4', 'a7a6', 'e4e5', 'd7d5', 'e5d6'] }).ok, true);
    assert.equal(controller.seek(4).ok, true);
    const before = controller.presentationSnapshot()!;
    assert.equal(controller.stepForward().ok, true);
    return { before, after: controller.presentationSnapshot()!, transition: controller.lastTransition()! };
  })();
  const enPassantPlan = createReplayAnimationPlan(enPassant.before, enPassant.after, enPassant.transition);
  assert.deepEqual(enPassantPlan.effects.map((effect) => effect.kind), ['move', 'capture']);
  assert.equal(enPassantPlan.effects[1].kind === 'capture' && enPassantPlan.effects[1].square, 'd5');

  const promotion = transitionFor(position({ a1: white('king'), g7: white('pawn'), a8: black('king') }), 'g7g8q');
  const promotionPlan = createReplayAnimationPlan(promotion.before, promotion.after, promotion.transition);
  assert.deepEqual(promotionPlan.effects.map((effect) => effect.kind), ['move', 'promotion']);
  const pawnBeforePromotion = promotionPlan.frame(PROMOTION_START_PROGRESS - 0.01).pieces.find((piece) => piece.piece_identity === promotion.transition.piece_identity);
  const queenAtPromotion = promotionPlan.frame(PROMOTION_START_PROGRESS).pieces.find((piece) => piece.piece_identity === promotion.transition.piece_identity);
  assert.equal(pawnBeforePromotion?.piece_type, 'pawn');
  assert.equal(queenAtPromotion?.piece_type, 'queen');
});

test('reduced motion is immediate and cancellation settles on the authoritative after snapshot', () => {
  const run = transitionFor({ kind: 'standard' }, 'e2e4');
  const immediate = createReplayAnimationModel();
  const immediatePlan = immediate.begin(run.before, run.after, run.transition, { reducedMotion: true });
  assert.equal(immediatePlan.mode, 'immediate');
  assert.equal(immediate.status, 'settled');
  assert.equal(immediate.frame(0)?.settled, true);

  const model = createReplayAnimationModel();
  model.begin(run.before, run.after, run.transition);
  assert.equal(model.status, 'running');
  const cancelled = model.cancel();
  assert.equal(model.status, 'cancelled');
  assert.equal(cancelled?.settled, true);
  assert.deepEqual(cancelled?.pieces, model.activePlan!.frame(1).pieces);
  const settled = model.settle();
  assert.equal(model.status, 'settled');
  assert.deepEqual(settled, cancelled);
});

test('elapsed-time sampling is deterministic and validates invalid inputs', () => {
  const run = transitionFor({ kind: 'standard' }, 'e2e4');
  const plan = createReplayAnimationPlan(run.before, run.after, run.transition, { durationMs: 1000 });
  assert.equal(plan.frameAt(500).progress, 0.5);
  assert.equal(plan.frameAt(1000).settled, true);
  assert.throws(() => plan.frameAt(-1), /finite and non-negative/);
  assert.throws(() => plan.frame(Number.NaN), /progress must be finite/);
});
