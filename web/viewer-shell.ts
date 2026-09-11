import { createReplayController } from '../replay/controller.ts';
import type { ReplayController } from '../replay/controller.ts';
import type { PresentationSnapshot, PresentedPiece } from '../replay/presentation.ts';
import type { Color, PieceType, Replay } from '../replay/schema.ts';
import type { ReplayState } from '../replay/engine.ts';
import { cloneCuratedReplay, DEFAULT_CURATED_REPLAY_ID } from '../replay/library.ts';

export const DEFAULT_REPLAY_ID = DEFAULT_CURATED_REPLAY_ID;
const defaultReplay = cloneCuratedReplay(DEFAULT_REPLAY_ID);
if (defaultReplay === null) throw new Error('The default curated replay is missing');
export const DEFAULT_REPLAY: Replay = defaultReplay;

export type PublicRoute = 'viewer' | 'simulator';
export type ReplaySpeed = 0.5 | 1 | 2;

export interface ViewerShellState {
  controller: ReplayController;
  replay: Replay;
  rootState: ReplayState;
  paused: boolean;
  boardFlipped: boolean;
  speed: ReplaySpeed;
}

export const PIECE_GLYPHS: Record<Color, Record<PieceType, string>> = {
  white: { king: '♔', queen: '♕', rook: '♖', bishop: '♗', knight: '♘', pawn: '♙' },
  black: { king: '♚', queen: '♛', rook: '♜', bishop: '♝', knight: '♞', pawn: '♟' },
};

export function resolvePublicRoute(pathname: string): PublicRoute {
  const normalized = pathname.trim().replace(/\/+$/, '') || '/';
  return normalized === '/simulator' || normalized.startsWith('/simulator/') ? 'simulator' : 'viewer';
}

export function createViewerState(replay: Replay = DEFAULT_REPLAY): ViewerShellState {
  const controller = createReplayController({ cache: 'full' });
  const loaded = controller.load(replay);
  if (!loaded.ok) throw new Error('The viewer replay could not be loaded: ' + loaded.error.message);
  return {
    controller,
    replay: structuredClone(loaded.replay),
    rootState: structuredClone(loaded.root_state),
    paused: true,
    boardFlipped: false,
    speed: 1,
  };
}

export function createDefaultViewerState(): ViewerShellState {
  return createViewerState(DEFAULT_REPLAY);
}

export function replayMetadataText(replay: Replay, key: string, fallback: string): string {
  const value = replay.metadata?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : fallback;
}

export function boardSquareOrder(flipped: boolean): string[] {
  const ranks = flipped ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0];
  const files = flipped ? [7, 6, 5, 4, 3, 2, 1, 0] : [0, 1, 2, 3, 4, 5, 6, 7];
  return ranks.flatMap((rank) => files.map((file) => 'abcdefgh'[file] + String(rank + 1)));
}

export function piecesBySquare(snapshot: PresentationSnapshot): Map<string, PresentedPiece> {
  return new Map(snapshot.pieces.map((piece) => [piece.board_square, piece]));
}

export function moveContext(rootState: ReplayState, ply: number): { fullmove: number; side: Color } {
  if (!Number.isInteger(ply) || ply < 1) {
    return { fullmove: rootState.fullmove_number, side: rootState.side_to_move };
  }
  const moveIndex = ply - 1;
  const blackRoot = rootState.side_to_move === 'black';
  const isWhite = blackRoot ? moveIndex % 2 === 1 : moveIndex % 2 === 0;
  return {
    fullmove: rootState.fullmove_number + Math.floor((moveIndex + (blackRoot ? 1 : 0)) / 2),
    side: isWhite ? 'white' : 'black',
  };
}
