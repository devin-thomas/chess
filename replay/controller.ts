import { ReplayError } from "./schema.ts";
import type { Replay } from "./schema.ts";
import { createReplaySession } from "./engine.ts";
import type { ReplaySession, ReplayState } from "./engine.ts";
import { validateReplay } from "./validate.ts";
import { createPresentationAdapter } from "./presentation.ts";
import type { MoveRecord, PresentationEvent, PresentationSnapshot } from "./presentation.ts";

export type NavigationResult =
  | { ok: true; state: ReplayState }
  | { ok: false; error: ReplayError };

export type ReplayStatus = "unloaded" | "ready" | "ended";

/** The reference controller reconstructs from root so navigation retains all rule history. */
export function createReplayController() {
  let replay: Replay | null = null;
  let session: ReplaySession | null = null;
  let currentPly = 0;
  const presentation = createPresentationAdapter();
  let transition: MoveRecord | null = null;
  let events: readonly PresentationEvent[] = [];

  function noSession(): NavigationResult {
    return { ok: false, error: new ReplayError("E_REPLAY_NO_SESSION", "Load a replay before navigating") };
  }

  function clearTransition() {
    transition = null;
    events = [];
  }

  function seek(ply: number): NavigationResult {
    if (replay === null || session === null) return noSession();
    if (!Number.isInteger(ply) || ply < 0 || ply > replay.moves.length) {
      return { ok: false, error: new ReplayError("E_REPLAY_RANGE", "Replay ply must be an integer within the replay") };
    }
    if (ply === currentPly) {
      clearTransition();
      return { ok: true, state: session.state() };
    }

    const nextSession = createReplaySession(replay.root);
    const root = nextSession.state();
    const transitions = [];
    for (let index = 0; index < ply; index += 1) {
      const move = replay.moves[index];
      const before = nextSession.state();
      const after = nextSession.play(move);
      transitions.push({ move, before, after, ply: index + 1 });
    }
    const update = presentation.reconstruct(root, transitions, nextSession.legalMoves());
    session = nextSession;
    currentPly = ply;
    transition = update.transition;
    events = update.events;
    return { ok: true, state: session.state() };
  }

  return {
    load(input: unknown) {
      const validation = validateReplay(input);
      if (!validation.ok) return validation;
      const nextSession = createReplaySession(validation.replay.root);
      const update = presentation.reset(nextSession.state(), nextSession.legalMoves());
      // Validation owns its input copy; keep a separate copy from the public result as well.
      replay = structuredClone(validation.replay);
      session = nextSession;
      currentPly = 0;
      transition = update.transition;
      events = update.events;
      return validation;
    },
    length(): number { return replay?.moves.length ?? 0; },
    currentPly(): number { return currentPly; },
    status(): ReplayStatus {
      if (replay === null) return "unloaded";
      return currentPly === replay.moves.length ? "ended" : "ready";
    },
    position(): ReplayState | null { return session?.state() ?? null; },
    moveAt(ply: number): string | null {
      if (replay === null || !Number.isInteger(ply) || ply < 1 || ply > replay.moves.length) return null;
      return replay.moves[ply - 1];
    },
    seek,
    stepForward(): NavigationResult {
      if (replay === null || session === null) return noSession();
      if (currentPly === replay.moves.length) {
        clearTransition();
        return { ok: true, state: session.state() };
      }
      const move = replay.moves[currentPly];
      const before = session.state();
      const after = session.play(move);
      const update = presentation.advance(move, before, after, currentPly + 1, { legalMoves: session.legalMoves() });
      currentPly += 1;
      transition = update.transition;
      events = update.events;
      return { ok: true, state: after };
    },
    stepBack(): NavigationResult {
      if (session === null) return noSession();
      return seek(Math.max(0, currentPly - 1));
    },
    presentationSnapshot(): PresentationSnapshot | null {
      return replay === null ? null : presentation.snapshot();
    },
    lastTransition(): MoveRecord | null { return transition === null ? null : structuredClone(transition); },
    eventsForTransition(): readonly PresentationEvent[] { return structuredClone(events); },
  };
}

export type ReplayController = ReturnType<typeof createReplayController>;
