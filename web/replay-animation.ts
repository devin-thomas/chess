import type {
  MoveRecord,
  PresentedPiece,
  PresentationSnapshot,
} from '../replay/presentation.ts';
import type { Color, PieceType } from '../replay/schema.ts';

export const DEFAULT_ANIMATION_DURATION_MS = 420;
export const CAPTURE_END_PROGRESS = 0.2;
export const PROMOTION_START_PROGRESS = 0.8;

export type ReplayAnimationMode = 'animated' | 'immediate';
export type ReplayAnimationStatus = 'idle' | 'running' | 'cancelled' | 'settled';

export interface ReplayAnimationOptions {
  readonly durationMs?: number;
  readonly mode?: ReplayAnimationMode;
  readonly reducedMotion?: boolean;
}

export interface BoardAnimationPosition {
  readonly kind: 'square' | 'interpolated';
  readonly square?: string;
  readonly from?: string;
  readonly to?: string;
  readonly progress?: number;
}

export interface AnimationPieceFrame {
  readonly piece_identity: string;
  readonly piece_type: PieceType;
  readonly color: Color;
  readonly visual_asset_id: string;
  readonly position: BoardAnimationPosition;
  readonly visible: boolean;
}

export interface ReplayAnimationFrame {
  readonly progress: number;
  readonly settled: boolean;
  readonly pieces: readonly AnimationPieceFrame[];
}

export interface MoveAnimationEffect {
  readonly kind: 'move';
  readonly piece_identity: string;
  readonly from: string;
  readonly to: string;
  readonly start_progress: 0;
  readonly end_progress: 1;
}

export interface CaptureAnimationEffect {
  readonly kind: 'capture';
  readonly piece_identity: string;
  readonly square: string;
  readonly start_progress: 0;
  readonly end_progress: typeof CAPTURE_END_PROGRESS;
}

export interface CastlingAnimationEffect {
  readonly kind: 'castling';
  readonly piece_identity: string;
  readonly from: string;
  readonly to: string;
  readonly start_progress: 0;
  readonly end_progress: 1;
}

export interface PromotionAnimationEffect {
  readonly kind: 'promotion';
  readonly piece_identity: string;
  readonly square: string;
  readonly from_type: PieceType;
  readonly to_type: PieceType;
  readonly start_progress: typeof PROMOTION_START_PROGRESS;
  readonly end_progress: 1;
}

export type ReplayAnimationEffect =
  | MoveAnimationEffect
  | CaptureAnimationEffect
  | CastlingAnimationEffect
  | PromotionAnimationEffect;

export interface ReplayAnimationPlan {
  readonly before: PresentationSnapshot;
  readonly after: PresentationSnapshot;
  readonly transition: MoveRecord;
  readonly mode: ReplayAnimationMode;
  readonly durationMs: number;
  /** Effects are ordered move, capture, castling, then promotion. */
  readonly effects: readonly ReplayAnimationEffect[];
  frame(progress: number): ReplayAnimationFrame;
  frameAt(elapsedMs: number): ReplayAnimationFrame;
}

export interface ReplayAnimationModel {
  readonly status: ReplayAnimationStatus;
  readonly activePlan: ReplayAnimationPlan | null;
  begin(
    before: PresentationSnapshot,
    after: PresentationSnapshot,
    transition: MoveRecord,
    options?: ReplayAnimationOptions,
  ): ReplayAnimationPlan;
  frame(progress: number): ReplayAnimationFrame | null;
  frameAt(elapsedMs: number): ReplayAnimationFrame | null;
  cancel(): ReplayAnimationFrame | null;
  settle(): ReplayAnimationFrame | null;
}

function assertSquare(square: string): void {
  if (!/^[a-h][1-8]$/.test(square)) throw new Error(`Invalid animation square: ${square}`);
}

function clampProgress(progress: number): number {
  if (!Number.isFinite(progress)) throw new Error('Animation progress must be finite');
  return Math.min(1, Math.max(0, progress));
}

function validateDuration(durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    throw new Error('Animation duration must be a finite non-negative number');
  }
  return durationMs;
}

interface SnapshotMaps {
  readonly byIdentity: ReadonlyMap<string, PresentedPiece>;
  readonly bySquare: ReadonlyMap<string, PresentedPiece>;
}

function snapshotMaps(snapshot: PresentationSnapshot): SnapshotMaps {
  const byIdentity = new Map<string, PresentedPiece>();
  const bySquare = new Map<string, PresentedPiece>();
  for (const piece of snapshot.pieces) {
    assertSquare(piece.board_square);
    if (byIdentity.has(piece.piece_identity)) {
      throw new Error(`Animation snapshot has duplicate piece identity: ${piece.piece_identity}`);
    }
    if (bySquare.has(piece.board_square)) {
      throw new Error(`Animation snapshot has duplicate square: ${piece.board_square}`);
    }
    byIdentity.set(piece.piece_identity, piece);
    bySquare.set(piece.board_square, piece);
  }
  return { byIdentity, bySquare };
}

function requirePiece(
  pieces: ReadonlyMap<string, PresentedPiece>,
  identity: string,
  description: string,
): PresentedPiece {
  const piece = pieces.get(identity);
  if (!piece) throw new Error(`Animation transition references missing ${description}: ${identity}`);
  return piece;
}

function validateTransition(before: SnapshotMaps, after: SnapshotMaps, transition: MoveRecord): void {
  assertSquare(transition.from);
  assertSquare(transition.to);
  const movingBefore = requirePiece(before.byIdentity, transition.piece_identity, 'moving piece');
  const movingAfter = requirePiece(after.byIdentity, transition.piece_identity, 'post-move piece');
  if (movingBefore.board_square !== transition.from || movingAfter.board_square !== transition.to) {
    throw new Error('Animation transition does not match the moving piece in its snapshots');
  }
  if (movingBefore.color !== transition.actor || movingBefore.piece_type !== transition.original_type) {
    throw new Error('Animation transition does not match the moving piece metadata');
  }
  if (transition.promotion !== null && movingAfter.piece_type !== transition.promotion) {
    throw new Error('Animation promotion does not match the authoritative post-move piece');
  }
  if (transition.promotion === null && movingAfter.piece_type !== movingBefore.piece_type) {
    throw new Error('Animation transition changes piece type without a promotion effect');
  }

  if (transition.captured) {
    assertSquare(transition.captured.square);
    const captured = requirePiece(before.byIdentity, transition.captured.piece_identity, 'captured piece');
    if (captured.board_square !== transition.captured.square || after.byIdentity.has(captured.piece_identity)) {
      throw new Error('Animation capture does not match the authoritative snapshots');
    }
  }
  if (transition.en_passant_capture_square !== null) {
    assertSquare(transition.en_passant_capture_square);
    if (!transition.captured || transition.captured.square !== transition.en_passant_capture_square) {
      throw new Error('Animation en passant effect does not match the captured square');
    }
  }
  if (transition.castling_rook) {
    assertSquare(transition.castling_rook.from);
    assertSquare(transition.castling_rook.to);
    const rookBefore = requirePiece(before.byIdentity, transition.castling_rook.piece_identity, 'castling rook');
    const rookAfter = requirePiece(after.byIdentity, transition.castling_rook.piece_identity, 'post-castling rook');
    if (rookBefore.board_square !== transition.castling_rook.from || rookAfter.board_square !== transition.castling_rook.to) {
      throw new Error('Animation castling effect does not match the authoritative snapshots');
    }
  }
}

function pieceFrame(piece: PresentedPiece, position: BoardAnimationPosition, visible = true): AnimationPieceFrame {
  return {
    piece_identity: piece.piece_identity,
    piece_type: piece.piece_type,
    color: piece.color,
    visual_asset_id: piece.visual_asset_id,
    position,
    visible,
  };
}

function squarePosition(square: string): BoardAnimationPosition {
  return { kind: 'square', square };
}

function interpolatedPosition(from: string, to: string, progress: number): BoardAnimationPosition {
  return { kind: 'interpolated', from, to, progress };
}

function authoritativeFrame(snapshot: PresentationSnapshot): ReplayAnimationFrame {
  return {
    progress: 1,
    settled: true,
    pieces: snapshot.pieces.map((piece) => pieceFrame(piece, squarePosition(piece.board_square))),
  };
}

function createEffects(transition: MoveRecord): ReplayAnimationEffect[] {
  const effects: ReplayAnimationEffect[] = [{
    kind: 'move',
    piece_identity: transition.piece_identity,
    from: transition.from,
    to: transition.to,
    start_progress: 0,
    end_progress: 1,
  }];
  if (transition.captured) {
    effects.push({
      kind: 'capture',
      piece_identity: transition.captured.piece_identity,
      square: transition.captured.square,
      start_progress: 0,
      end_progress: CAPTURE_END_PROGRESS,
    });
  }
  if (transition.castling_rook) {
    effects.push({
      kind: 'castling',
      piece_identity: transition.castling_rook.piece_identity,
      from: transition.castling_rook.from,
      to: transition.castling_rook.to,
      start_progress: 0,
      end_progress: 1,
    });
  }
  if (transition.promotion) {
    effects.push({
      kind: 'promotion',
      piece_identity: transition.piece_identity,
      square: transition.to,
      from_type: transition.original_type,
      to_type: transition.promotion,
      start_progress: PROMOTION_START_PROGRESS,
      end_progress: 1,
    });
  }
  return effects;
}

function createIntermediateFrame(
  before: SnapshotMaps,
  after: SnapshotMaps,
  transition: MoveRecord,
  progress: number,
): ReplayAnimationFrame {
  const movingBefore = requirePiece(before.byIdentity, transition.piece_identity, 'moving piece');
  const movingAfter = requirePiece(after.byIdentity, transition.piece_identity, 'post-move piece');
  const rook = transition.castling_rook;
  const captured = transition.captured;
  const identities = new Set([...before.byIdentity.keys(), ...after.byIdentity.keys()]);
  const pieces: AnimationPieceFrame[] = [];

  for (const identity of [...identities].sort()) {
    const beforePiece = before.byIdentity.get(identity);
    const afterPiece = after.byIdentity.get(identity);
    if (identity === transition.piece_identity) {
      const promoted = transition.promotion !== null && progress >= PROMOTION_START_PROGRESS;
      const descriptor = promoted ? movingAfter : movingBefore;
      pieces.push(pieceFrame(descriptor, interpolatedPosition(transition.from, transition.to, progress)));
    } else if (rook && identity === rook.piece_identity) {
      const descriptor = afterPiece ?? beforePiece;
      if (descriptor) pieces.push(pieceFrame(descriptor, interpolatedPosition(rook.from, rook.to, progress)));
    } else if (captured && identity === captured.piece_identity && beforePiece) {
      pieces.push(pieceFrame(beforePiece, squarePosition(captured.square), progress < CAPTURE_END_PROGRESS));
    } else if (afterPiece) {
      pieces.push(pieceFrame(afterPiece, squarePosition(afterPiece.board_square)));
    } else if (beforePiece) {
      pieces.push(pieceFrame(beforePiece, squarePosition(beforePiece.board_square), false));
    }
  }
  return { progress, settled: false, pieces };
}

export function createReplayAnimationPlan(
  beforeSnapshot: PresentationSnapshot,
  afterSnapshot: PresentationSnapshot,
  transition: MoveRecord,
  options: ReplayAnimationOptions = {},
): ReplayAnimationPlan {
  const before = snapshotMaps(beforeSnapshot);
  const after = snapshotMaps(afterSnapshot);
  validateTransition(before, after, transition);
  const mode: ReplayAnimationMode = options.reducedMotion ? 'immediate' : (options.mode ?? 'animated');
  const durationMs = mode === 'immediate' ? 0 : validateDuration(options.durationMs ?? DEFAULT_ANIMATION_DURATION_MS);
  const effects = Object.freeze(createEffects(transition));
  const settled = authoritativeFrame(afterSnapshot);

  return Object.freeze({
    before: beforeSnapshot,
    after: afterSnapshot,
    transition,
    mode,
    durationMs,
    effects,
    frame(progress: number): ReplayAnimationFrame {
      const normalized = mode === 'immediate' ? 1 : clampProgress(progress);
      if (normalized >= 1) return settled;
      if (normalized <= 0) {
        return {
          progress: 0,
          settled: false,
          pieces: beforeSnapshot.pieces.map((piece) => pieceFrame(piece, squarePosition(piece.board_square))),
        };
      }
      return createIntermediateFrame(before, after, transition, normalized);
    },
    frameAt(elapsedMs: number): ReplayAnimationFrame {
      if (!Number.isFinite(elapsedMs) || elapsedMs < 0) throw new Error('Animation elapsed time must be finite and non-negative');
      return this.frame(durationMs === 0 ? 1 : elapsedMs / durationMs);
    },
  });
}

export function createReplayAnimationModel(): ReplayAnimationModel {
  let currentPlan: ReplayAnimationPlan | null = null;
  let currentStatus: ReplayAnimationStatus = 'idle';

  const model: ReplayAnimationModel = {
    get status() {
      return currentStatus;
    },
    get activePlan() {
      return currentPlan;
    },
    begin(before, after, transition, options = {}) {
      currentPlan = createReplayAnimationPlan(before, after, transition, options);
      currentStatus = currentPlan.mode === 'immediate' ? 'settled' : 'running';
      return currentPlan;
    },
    frame(progress) {
      if (!currentPlan) return null;
      const frame = currentPlan.frame(progress);
      if (frame.settled) currentStatus = 'settled';
      return frame;
    },
    frameAt(elapsedMs) {
      if (!currentPlan) return null;
      const frame = currentPlan.frameAt(elapsedMs);
      if (frame.settled) currentStatus = 'settled';
      return frame;
    },
    cancel() {
      if (!currentPlan) return null;
      const frame = authoritativeFrame(currentPlan.after);
      currentStatus = 'cancelled';
      return frame;
    },
    settle() {
      if (!currentPlan) return null;
      const frame = authoritativeFrame(currentPlan.after);
      currentStatus = 'settled';
      return frame;
    },
  };
  return model;
}
