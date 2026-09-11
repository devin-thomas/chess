import { ReplayError } from './schema.ts';
import type { Replay } from './schema.ts';
import { createReplaySession } from './engine.ts';
import type { ReplaySession, ReplayState } from './engine.ts';
import { validateReplay } from './validate.ts';
import { createPresentationAdapter } from './presentation.ts';
import type { MoveRecord, PresentationEvent, PresentationSnapshot } from './presentation.ts';
import { buildReplayHistoryCache } from './cache.ts';
import type { ReplayHistoryCache } from './cache.ts';

export type NavigationResult =
  | { ok: true; state: ReplayState }
  | { ok: false; error: ReplayError };

export type ReplayStatus = 'unloaded' | 'ready' | 'ended';
export type ReplayCacheMode = 'none' | 'full';

export interface ReplayControllerOptions {
  /** `false`/`none` keeps the reference root-reconstruction path. */
  cache?: boolean | ReplayCacheMode;
}

export interface ReplaySeekTiming {
  readonly ply: number;
  readonly mode: ReplayCacheMode;
  readonly cacheHit: boolean;
  readonly durationMs: number;
}

export interface ReplayCacheStats {
  readonly mode: ReplayCacheMode;
  readonly entries: number;
  readonly hits: number;
  readonly misses: number;
  readonly builds: number;
  readonly lastSeek: ReplaySeekTiming | null;
}

function clockMs(): number {
  return typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() : Date.now();
}

/** The reference controller can reconstruct from root; the web enables the full cache. */
export function createReplayController(options: ReplayControllerOptions = {}) {
  const cacheEnabled = options.cache === true || options.cache === 'full';
  let replay: Replay | null = null;
  let session: ReplaySession | null = null;
  let currentState: ReplayState | null = null;
  let historyCache: ReplayHistoryCache | null = null;
  let currentPly = 0;
  let cacheHits = 0;
  let cacheMisses = 0;
  let cacheBuilds = 0;
  let lastSeek: ReplaySeekTiming | null = null;
  const presentation = createPresentationAdapter();
  let transition: MoveRecord | null = null;
  let events: readonly PresentationEvent[] = [];

  function noSession(): NavigationResult {
    return { ok: false, error: new ReplayError('E_REPLAY_NO_SESSION', 'Load a replay before navigating') };
  }

  function clearTransition(): void {
    transition = null;
    events = [];
  }

  function recordSeek(ply: number, startedAt: number, cacheHit: boolean, countCacheAttempt = true): void {
    if (cacheEnabled && countCacheAttempt && !cacheHit) cacheMisses += 1;
    lastSeek = {
      ply,
      mode: cacheEnabled ? 'full' : 'none',
      cacheHit,
      durationMs: Number(Math.max(0, clockMs() - startedAt).toFixed(3)),
    };
  }

  function seek(ply: number): NavigationResult {
    if (replay === null || currentState === null) return noSession();
    if (!Number.isInteger(ply) || ply < 0 || ply > replay.moves.length) {
      return { ok: false, error: new ReplayError('E_REPLAY_RANGE', 'Replay ply must be an integer within the replay') };
    }
    const startedAt = clockMs();
    if (ply === currentPly) {
      clearTransition();
      recordSeek(ply, startedAt, false, false);
      return { ok: true, state: structuredClone(currentState) };
    }

    if (historyCache !== null) {
      const checkpoint = historyCache.checkpointAt(ply);
      const update = presentation.restore(checkpoint.state, checkpoint.presentation.pieces,
        checkpoint.legalMoves);
      session = historyCache.sessionAt(ply);
      currentState = checkpoint.state;
      currentPly = ply;
      transition = update.transition;
      events = update.events;
      cacheHits += 1;
      recordSeek(ply, startedAt, true);
      return { ok: true, state: structuredClone(currentState) };
    }

    const nextSession = createReplaySession(replay.root);
    const root = nextSession.state();
    const transitions: { move: string; before: ReplayState; after: ReplayState; ply: number }[] = [];
    for (let index = 0; index < ply; index += 1) {
      const move = replay.moves[index];
      const before = nextSession.state();
      const after = nextSession.play(move);
      transitions.push({ move, before, after, ply: index + 1 });
    }
    const update = presentation.reconstruct(root, transitions, nextSession.legalMoves());
    session = nextSession;
    currentState = nextSession.state();
    currentPly = ply;
    transition = update.transition;
    events = update.events;
    recordSeek(ply, startedAt, false);
    return { ok: true, state: structuredClone(currentState) };
  }

  return {
    load(input: unknown) {
      const validation = validateReplay(input);
      if (!validation.ok) return validation;

      // Build the candidate cache before changing the active session so a
      // failed candidate cannot invalidate the currently visible replay.
      const nextReplay = structuredClone(validation.replay);
      const nextCache = cacheEnabled
        ? buildReplayHistoryCache(nextReplay.root, nextReplay.moves)
        : null;
      const nextSession = createReplaySession(nextReplay.root);
      const root = nextSession.state();
      const update = presentation.reset(root, nextSession.legalMoves());

      replay = nextReplay;
      session = nextSession;
      currentState = structuredClone(root);
      historyCache = nextCache;
      currentPly = 0;
      cacheHits = 0;
      cacheMisses = 0;
      cacheBuilds += nextCache === null ? 0 : 1;
      lastSeek = null;
      transition = update.transition;
      events = update.events;
      return validation;
    },
    length(): number { return replay?.moves.length ?? 0; },
    currentPly(): number { return currentPly; },
    status(): ReplayStatus {
      if (replay === null) return 'unloaded';
      return currentPly === replay.moves.length ? 'ended' : 'ready';
    },
    position(): ReplayState | null {
      return currentState === null ? null : structuredClone(currentState);
    },
    moveAt(ply: number): string | null {
      if (replay === null || !Number.isInteger(ply) || ply < 1 || ply > replay.moves.length) return null;
      return replay.moves[ply - 1];
    },
    seek,
    stepForward(): NavigationResult {
      if (replay === null || currentState === null || session === null) return noSession();
      if (currentPly === replay.moves.length) {
        clearTransition();
        return { ok: true, state: structuredClone(currentState) };
      }

      const move = replay.moves[currentPly];
      const before = session.state();
      const after = session.play(move);
      const update = presentation.advance(move, before, after, currentPly + 1, { legalMoves: session.legalMoves() });
      currentPly += 1;
      currentState = structuredClone(after);
      transition = update.transition;
      events = update.events;
      return { ok: true, state: structuredClone(currentState) };
    },
    stepBack(): NavigationResult {
      if (currentState === null) return noSession();
      return seek(Math.max(0, currentPly - 1));
    },
    presentationSnapshot(): PresentationSnapshot | null {
      return replay === null ? null : presentation.snapshot();
    },
    lastTransition(): MoveRecord | null { return transition === null ? null : structuredClone(transition); },
    eventsForTransition(): readonly PresentationEvent[] { return structuredClone(events); },
    cacheMode(): ReplayCacheMode { return cacheEnabled ? 'full' : 'none'; },
    cacheStats(): ReplayCacheStats {
      return {
        mode: cacheEnabled ? 'full' : 'none',
        entries: historyCache?.entries ?? 0,
        hits: cacheHits,
        misses: cacheMisses,
        builds: cacheBuilds,
        lastSeek: lastSeek === null ? null : { ...lastSeek },
      };
    },
    lastSeekTiming(): ReplaySeekTiming | null {
      return lastSeek === null ? null : { ...lastSeek };
    },
  };
}

export type ReplayController = ReturnType<typeof createReplayController>;
