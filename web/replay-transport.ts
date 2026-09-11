import type { NavigationResult, ReplayController, ReplayStatus } from '../replay/controller.ts';
import type { ReplayError } from '../replay/schema.ts';
import type { ReplaySpeed } from './viewer-shell.ts';

export const REPLAY_SPEEDS = [0.5, 1, 2] as const satisfies readonly ReplaySpeed[];

export type ReplayTimerHandle = unknown;

export interface ReplayScheduler {
  setTimeout(callback: () => void, delayMs: number): ReplayTimerHandle;
  clearTimeout(handle: ReplayTimerHandle): void;
}

type NativeTimerHandle = ReturnType<typeof globalThis.setTimeout>;

/** The browser-independent default also works for node-based model tests. */
export const defaultReplayScheduler: ReplayScheduler = {
  setTimeout(callback, delayMs) {
    return globalThis.setTimeout(callback, delayMs) as unknown as ReplayTimerHandle;
  },
  clearTimeout(handle) {
    globalThis.clearTimeout(handle as NativeTimerHandle);
  },
};

export const browserReplayScheduler: ReplayScheduler = {
  setTimeout(callback, delayMs) {
    return window.setTimeout(callback, delayMs);
  },
  clearTimeout(handle) {
    window.clearTimeout(handle as number);
  },
};

export function replayDelayMs(speed: ReplaySpeed): number {
  return 1000 / speed;
}

export function isReplaySpeed(value: number): value is ReplaySpeed {
  return REPLAY_SPEEDS.includes(value as ReplaySpeed);
}

export interface ReplayTransportSnapshot {
  readonly currentPly: number;
  readonly length: number;
  readonly replayStatus: ReplayStatus;
  readonly speed: ReplaySpeed;
  readonly paused: boolean;
  readonly playing: boolean;
  readonly boardFlipped: boolean;
  readonly atStart: boolean;
  readonly atEnd: boolean;
  readonly canPlay: boolean;
  readonly canPause: boolean;
  readonly canStepBack: boolean;
  readonly canStepForward: boolean;
  readonly canJumpToStart: boolean;
  readonly canJumpToEnd: boolean;
  readonly timerPending: boolean;
}

export interface ReplayTransportOptions {
  scheduler?: ReplayScheduler;
  onChange?: (snapshot: ReplayTransportSnapshot) => void;
  onCancelAnimation?: () => void;
  onError?: (error: ReplayError) => void;
}

export interface ReplayTransport {
  snapshot(): ReplayTransportSnapshot;
  subscribe(listener: (snapshot: ReplayTransportSnapshot) => void): () => void;
  play(): boolean;
  pause(): void;
  togglePlayback(): boolean;
  seek(ply: number): NavigationResult;
  stepForward(): NavigationResult;
  stepBack(): NavigationResult;
  first(): NavigationResult;
  last(): NavigationResult;
  setSpeed(speed: ReplaySpeed): ReplayTransportSnapshot;
  setBoardFlipped(flipped: boolean): ReplayTransportSnapshot;
  toggleBoardFlip(): ReplayTransportSnapshot;
  isPlaying(): boolean;
  dispose(): void;
}

interface PendingTimer {
  readonly handle: ReplayTimerHandle;
  readonly token: number;
}

export function createReplayTransport(
  controller: ReplayController,
  options: ReplayTransportOptions = {},
): ReplayTransport {
  const scheduler = options.scheduler ?? defaultReplayScheduler;
  const listeners = new Set<(snapshot: ReplayTransportSnapshot) => void>();
  if (options.onChange) listeners.add(options.onChange);

  let paused = true;
  let speed: ReplaySpeed = 1;
  let boardFlipped = false;
  let pendingTimer: PendingTimer | null = null;
  let timerGeneration = 0;

  function snapshot(): ReplayTransportSnapshot {
    const currentPly = controller.currentPly();
    const length = controller.length();
    const atStart = currentPly === 0;
    const atEnd = currentPly >= length;
    const canPlay = length > 0 && !atEnd;
    return {
      currentPly,
      length,
      replayStatus: controller.status(),
      speed,
      paused,
      playing: !paused,
      boardFlipped,
      atStart,
      atEnd,
      canPlay,
      canPause: !paused,
      canStepBack: !atStart,
      canStepForward: !atEnd,
      canJumpToStart: !atStart,
      canJumpToEnd: !atEnd,
      timerPending: pendingTimer !== null,
    };
  }

  function emitChange(): void {
    const current = snapshot();
    for (const listener of listeners) listener(current);
  }

  function cancelTimer(): void {
    timerGeneration += 1;
    if (pendingTimer === null) return;
    scheduler.clearTimeout(pendingTimer.handle);
    pendingTimer = null;
  }

  function cancelTransientEffects(): void {
    cancelTimer();
    paused = true;
    options.onCancelAnimation?.();
  }

  function navigate(action: () => NavigationResult): NavigationResult {
    cancelTransientEffects();
    const result = action();
    emitChange();
    return result;
  }

  function schedulePlayback(): void {
    if (paused) return;
    const current = snapshot();
    if (!current.canPlay) {
      paused = true;
      cancelTimer();
      return;
    }

    const token = ++timerGeneration;
    const handle = scheduler.setTimeout(() => {
      if (pendingTimer === null || pendingTimer.token !== token || timerGeneration !== token) return;
      pendingTimer = null;
      if (paused) return;

      const result = controller.stepForward();
      if (!result.ok) {
        paused = true;
        timerGeneration += 1;
        emitChange();
        options.onError?.(result.error);
        return;
      }

      if (controller.currentPly() >= controller.length()) paused = true;
      if (!paused) schedulePlayback();
      emitChange();
    }, replayDelayMs(speed));
    pendingTimer = { handle, token };
  }

  function play(): boolean {
    if (!paused) return true;
    if (!snapshot().canPlay) {
      cancelTimer();
      return false;
    }
    paused = false;
    schedulePlayback();
    emitChange();
    return true;
  }

  function pause(): void {
    const changed = !paused || pendingTimer !== null;
    cancelTimer();
    paused = true;
    if (changed) {
      options.onCancelAnimation?.();
      emitChange();
    }
  }

  function setSpeed(nextSpeed: ReplaySpeed): ReplayTransportSnapshot {
    if (!isReplaySpeed(nextSpeed)) {
      throw new RangeError('Replay speed must be 0.5, 1, or 2');
    }
    speed = nextSpeed;
    if (!paused) {
      cancelTimer();
      schedulePlayback();
    }
    emitChange();
    return snapshot();
  }

  function setBoardFlipped(flipped: boolean): ReplayTransportSnapshot {
    boardFlipped = flipped;
    emitChange();
    return snapshot();
  }

  return {
    snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    play,
    pause,
    togglePlayback() {
      if (paused) return play();
      pause();
      return false;
    },
    seek(ply) {
      return navigate(() => controller.seek(ply));
    },
    stepForward() {
      return navigate(() => controller.stepForward());
    },
    stepBack() {
      return navigate(() => controller.stepBack());
    },
    first() {
      return navigate(() => controller.seek(0));
    },
    last() {
      return navigate(() => controller.seek(controller.length()));
    },
    setSpeed,
    setBoardFlipped,
    toggleBoardFlip() {
      return setBoardFlipped(!boardFlipped);
    },
    isPlaying() {
      return !paused;
    },
    dispose() {
      cancelTimer();
      paused = true;
      listeners.clear();
    },
  };
}
