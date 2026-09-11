import type { ReplayState } from './engine.ts';
import type { Color, PieceType } from './schema.ts';

export interface PresentedPiece {
  readonly piece_identity: string;
  readonly piece_type: PieceType;
  readonly color: Color;
  readonly board_square: string;
  readonly visual_asset_id: string;
}

export interface MoveRecord {
  readonly state_epoch: number;
  readonly event_sequence: number;
  readonly ply: number;
  readonly actor: Color;
  readonly move: string;
  readonly piece_identity: string;
  readonly original_type: PieceType;
  readonly from: string;
  readonly to: string;
  readonly captured: { readonly piece_identity: string; readonly square: string } | null;
  readonly promotion: PieceType | null;
  readonly castling_rook: { readonly piece_identity: string; readonly from: string; readonly to: string } | null;
  readonly en_passant_capture_square: string | null;
  readonly revision_before: number;
  readonly revision_after: number;
}

export type PresentationEventKind = 'state_reset_or_load' | 'move_accepted' | 'capture' | 'en_passant' |
  'castling' | 'promotion' | 'check' | 'checkmate' | 'stalemate' | 'draw' | 'move_rejected';

export interface PresentationEvent {
  readonly kind: PresentationEventKind;
  readonly state_epoch: number;
  readonly event_sequence: number;
  readonly revision_before: number | null;
  readonly revision_after: number | null;
  readonly after_ply: number;
  readonly move_record?: MoveRecord;
  readonly check?: Color;
  readonly outcome?: ReplayState['outcome'];
}

export interface PresentationSnapshot {
  readonly state_epoch: number;
  readonly rules_revision: number;
  readonly after_ply: number;
  readonly status: ReplayState['status'];
  readonly check: ReplayState['check'];
  readonly outcome: ReplayState['outcome'];
  readonly raw_en_passant_target: string | null;
  readonly effective_en_passant_target: string | null;
  readonly board_orientation: 'white';
  readonly pieces: readonly PresentedPiece[];
  readonly active_animation: null;
  readonly rule_state: ReplayState;
}

export interface PresentationUpdate {
  readonly snapshot: PresentationSnapshot;
  readonly events: readonly PresentationEvent[];
  readonly transition: MoveRecord | null;
}

export interface ReconstructionTransition {
  readonly move: string;
  readonly before: ReplayState;
  readonly after: ReplayState;
  readonly ply: number;
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function square(index: number): string {
  return String.fromCharCode(97 + index % 8) + (Math.floor(index / 8) + 1);
}

function index(squareName: string): number {
  return squareName.charCodeAt(0) - 97 + (Number(squareName[1]) - 1) * 8;
}

function rootPieces(state: ReplayState): Map<string, PresentedPiece> {
  const pieces = new Map<string, PresentedPiece>();
  for (const [i, piece] of state.board.entries()) {
    if (piece) pieces.set(square(i), {
      piece_identity: `piece-${pieces.size + 1}`, piece_type: piece.type,
      color: piece.color, board_square: square(i), visual_asset_id: `${piece.color}-${piece.type}`,
    });
  }
  return pieces;
}

function assertOccupancy(pieces: Map<string, PresentedPiece>, state: ReplayState): void {
  for (const [i, cell] of state.board.entries()) {
    const piece = pieces.get(square(i));
    if (cell ? !piece || piece.color !== cell.color || piece.piece_type !== cell.type : piece) {
      throw new Error(`Presentation identity history disagrees with authoritative board at ${square(i)}`);
    }
  }
}

// Only accepted moves enter this projection; legality remains entirely in the rules session.
function apply(pieces: Map<string, PresentedPiece>, input: ReconstructionTransition,
  epoch: number, sequence: number): { pieces: Map<string, PresentedPiece>; record: MoveRecord } {
  const { move, before, after, ply } = input;
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move) || after.revision !== ply || before.revision !== ply - 1) {
    throw new Error('Presentation transition requires an accepted coordinate move and consecutive revisions');
  }
  assertOccupancy(pieces, before);
  const from = move.slice(0, 2), to = move.slice(2, 4);
  const moving = pieces.get(from), destination = after.board[index(to)];
  if (!moving || !destination || moving.color !== before.side_to_move || destination.color !== moving.color) {
    throw new Error('Presentation transition is missing its authoritative moving piece');
  }
  const next = new Map(pieces);
  let captureSquare = to;
  let enPassant: string | null = null;
  if (moving.piece_type === 'pawn' && from[0] !== to[0] && !before.board[index(to)]) {
    captureSquare = to[0] + from[1];
    enPassant = captureSquare;
  }
  const captured = next.get(captureSquare);
  if (enPassant && (!captured || captured.piece_type !== 'pawn' || before.en_passant_target !== to)) {
    throw new Error('Presentation en passant effect disagrees with authoritative state');
  }
  next.delete(captureSquare);
  next.delete(from);
  next.set(to, { ...moving, board_square: to, piece_type: destination.type,
    visual_asset_id: `${destination.color}-${destination.type}` });
  let rook: MoveRecord['castling_rook'] = null;
  if (moving.piece_type === 'king' && Math.abs(index(to) - index(from)) === 2) {
    const kingside = to[0] === 'g';
    const rookFrom = (kingside ? 'h' : 'a') + from[1];
    const rookTo = (kingside ? 'f' : 'd') + from[1];
    const rookPiece = next.get(rookFrom);
    if (!rookPiece || rookPiece.piece_type !== 'rook' || rookPiece.color !== moving.color) {
      throw new Error('Presentation castling effect is missing its rook');
    }
    rook = { piece_identity: rookPiece.piece_identity, from: rookFrom, to: rookTo };
    next.delete(rookFrom);
    next.set(rookTo, { ...rookPiece, board_square: rookTo });
  }
  assertOccupancy(next, after);
  return { pieces: next, record: {
    state_epoch: epoch, event_sequence: sequence, ply, actor: moving.color, move,
    piece_identity: moving.piece_identity, original_type: moving.piece_type, from, to,
    captured: captured ? { piece_identity: captured.piece_identity, square: captureSquare } : null,
    promotion: move.length === 5 ? destination.type : null,
    castling_rook: rook, en_passant_capture_square: enPassant,
    revision_before: before.revision, revision_after: after.revision,
  } };
}

export function createPresentationAdapter() {
  let epoch = 0, sequence = 0;
  let pieces = new Map<string, PresentedPiece>();
  let current: PresentationSnapshot | null = null;

  function project(state: ReplayState, legalMoves: readonly string[]): PresentationSnapshot {
    const ep = state.en_passant_target;
    const effective = ep && legalMoves.some(move => {
      const source = state.board[index(move.slice(0, 2))];
      return move.slice(2, 4) === ep && source?.type === 'pawn' && move[0] !== move[2];
    }) ? ep : null;
    return freeze({ state_epoch: epoch, rules_revision: state.revision, after_ply: state.revision,
      status: state.status, check: state.check, outcome: structuredClone(state.outcome),
      raw_en_passant_target: ep, effective_en_passant_target: effective, board_orientation: 'white',
      pieces: [...pieces.values()].sort((a, b) => index(a.board_square) - index(b.board_square)),
      active_animation: null, rule_state: structuredClone(state) });
  }

  function reconstruct(rootState: ReplayState, transitions: readonly ReconstructionTransition[],
    legalMoves: readonly string[] = []): PresentationUpdate {
    if (rootState.revision !== 0) throw new Error('Presentation reconstruction must start at replay root');
    let rebuilt = rootPieces(rootState), state = rootState;
    for (const transition of transitions) {
      if (transition.before.revision !== state.revision) throw new Error('Nonconsecutive presentation reconstruction');
      rebuilt = apply(rebuilt, transition, epoch + 1, sequence).pieces;
      state = transition.after;
    }
    pieces = rebuilt;
    epoch++;
    current = project(state, legalMoves);
    return freeze({ snapshot: current, transition: null, events: [{ kind: 'state_reset_or_load',
      state_epoch: epoch, event_sequence: ++sequence, revision_before: null,
      revision_after: null, after_ply: state.revision }] });
  }

  return {
    reset(rootState: ReplayState, legalMoves: readonly string[] = []): PresentationUpdate {
      return reconstruct(rootState, [], legalMoves);
    },
    reconstruct,
    advance(move: string, before: ReplayState, after: ReplayState, ply: number,
      options: { emit?: boolean; legalMoves?: readonly string[] } = {}): PresentationUpdate {
      if (!current || current.rules_revision !== before.revision) throw new Error('Presentation adapter is not at the move source');
      const applied = apply(pieces, { move, before, after, ply }, epoch, sequence + 1);
      pieces = applied.pieces;
      current = project(after, options.legalMoves ?? []);
      const events: PresentationEvent[] = [];
      const record = applied.record;
      function emit(kind: PresentationEventKind): void {
        events.push({ kind, state_epoch: epoch, event_sequence: ++sequence,
          revision_before: before.revision, revision_after: after.revision, after_ply: ply,
          move_record: record, ...(kind === 'check' && after.check ? { check: after.check } : {}),
          ...(['checkmate', 'stalemate', 'draw'].includes(kind) ? { outcome: after.outcome && { ...after.outcome } } : {}) });
      }
      if (options.emit !== false) {
        emit('move_accepted');
        if (record.en_passant_capture_square) emit('en_passant');
        else if (record.captured) emit('capture');
        if (record.castling_rook) emit('castling');
        if (record.promotion) emit('promotion');
        if (after.check) emit('check');
        if (after.outcome) emit(after.outcome.reason === 'checkmate' ? 'checkmate' :
          after.outcome.reason === 'stalemate' ? 'stalemate' : 'draw');
      }
      return freeze({ snapshot: current, transition: options.emit === false ? null : record, events });
    },
    snapshot(): PresentationSnapshot {
      if (!current) throw new Error('No presentation state has been loaded');
      return current;
    },
  };
}
