import { createReplaySession } from '../replay/engine.ts';
import { formatCanonicalMoveAsSan } from '../replay/pgn-import.ts';
import type { Color, Replay } from '../replay/schema.ts';
import { moveContext } from './viewer-shell.ts';

export interface ReplayMoveListEntry {
  readonly ply: number;
  readonly fullmove: number;
  readonly side: Color;
  readonly canonical: string;
  readonly san: string;
  readonly move_number: string;
  readonly notation: string;
}

/** Build display notation from authoritative replay states while preserving cursor-friendly ply ids. */
export function buildReplayMoveList(replay: Replay): ReplayMoveListEntry[] {
  const session = createReplaySession(replay.root);
  const rootState = session.state();
  const entries: ReplayMoveListEntry[] = [];
  for (let index = 0; index < replay.moves.length; index += 1) {
    const canonical = replay.moves[index];
    const before = session.state();
    const legalMoves = session.legalMoves();
    const after = session.play(canonical);
    const ply = index + 1;
    const context = moveContext(rootState, ply);
    const fullmove = context.fullmove;
    const side = context.side;
    const san = formatCanonicalMoveAsSan(before, legalMoves, canonical, after);
    const move_number = `${fullmove}${side === 'white' ? '.' : '...'}`;
    entries.push(Object.freeze({
      ply,
      fullmove,
      side,
      canonical,
      san,
      move_number,
      notation: `${move_number} ${san}`,
    }));
    if (before.fullmove_number !== fullmove || before.side_to_move !== side) {
      throw new Error(`Replay move context disagrees with authoritative root at ply ${ply}`);
    }
  }
  return entries;
}

export const createReplayMoveList = buildReplayMoveList;
