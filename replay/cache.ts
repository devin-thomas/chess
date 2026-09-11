import { createReplaySession, ReplayEngineError } from './engine.ts';
import type { ReplaySession, ReplayState } from './engine.ts';
import { createPresentationAdapter } from './presentation.ts';
import type { PresentationSnapshot } from './presentation.ts';
import type { ReplayRoot } from './schema.ts';

export interface ReplayHistoryCheckpoint {
  readonly state: ReplayState;
  readonly legalMoves: readonly string[];
  readonly presentation: PresentationSnapshot;
}

export interface ReplayHistoryCache {
  readonly length: number;
  readonly entries: number;
  checkpointAt(ply: number): ReplayHistoryCheckpoint;
  sessionAt(ply: number): ReplaySession;
}

function assertPly(ply: number, length: number): void {
  if (!Number.isInteger(ply) || ply < 0 || ply > length) {
    throw new RangeError('Replay cache ply is outside the replay');
  }
}

/**
 * Build immutable full-history snapshots from the authoritative rules session.
 * The identity sidecar is cached with each state so a web seek does not replay
 * hidden moves through the presentation adapter.
 */
export function buildReplayHistoryCache(root: ReplayRoot, moves: readonly string[]): ReplayHistoryCache {
  const session = createReplaySession(root);
  const presentation = createPresentationAdapter();
  const states: ReplayState[] = [];
  const legalMoves: string[][] = [];
  const snapshots: PresentationSnapshot[] = [];

  let state = session.state();
  let update = presentation.reset(state, session.legalMoves());
  states.push(structuredClone(state));
  legalMoves.push(session.legalMoves());
  snapshots.push(structuredClone(update.snapshot));

  for (const [index, move] of moves.entries()) {
    const before = state;
    state = session.play(move);
    const nextLegalMoves = session.legalMoves();
    update = presentation.advance(move, before, state, index + 1, {
      emit: false,
      legalMoves: nextLegalMoves,
    });
    states.push(structuredClone(state));
    legalMoves.push([...nextLegalMoves]);
    snapshots.push(structuredClone(update.snapshot));
  }

  return {
    length: moves.length,
    entries: states.length,
    checkpointAt(ply: number): ReplayHistoryCheckpoint {
      assertPly(ply, moves.length);
      return {
        state: structuredClone(states[ply]),
        legalMoves: [...legalMoves[ply]],
        presentation: structuredClone(snapshots[ply]),
      };
    },
    sessionAt(ply: number): ReplaySession {
      assertPly(ply, moves.length);
      let cursor = ply;
      return {
        state: () => structuredClone(states[cursor]),
        play(move: string): ReplayState {
          if (cursor >= moves.length) {
            throw new ReplayEngineError('E_REPLAY_CACHE', 'Cached replay session is at the end');
          }
          if (moves[cursor] !== move) {
            throw new ReplayEngineError('E_REPLAY_CACHE', 'Cached replay move does not match the canonical sequence');
          }
          cursor += 1;
          return structuredClone(states[cursor]);
        },
        legalMoves: () => [...legalMoves[cursor]],
      };
    },
  };
}
