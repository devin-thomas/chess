import assert from 'node:assert/strict';
import test from 'node:test';
import { createReplayController } from '../replay/controller.ts';
import type { Replay } from '../replay/schema.ts';
import {
  createReplayTransport,
  replayDelayMs,
  type ReplayScheduler,
  type ReplayTimerHandle,
} from '../web/replay-transport.ts';

const opening: Replay = {
  schema_version: 1,
  ruleset: 'orthodox-chess-v1',
  root: { kind: 'standard' },
  moves: ['e2e4', 'e7e5', 'g1f3'],
};

interface TimerEntry {
  readonly handle: number;
  readonly callback: () => void;
  readonly delayMs: number;
  cancelled: boolean;
  fired: boolean;
}

class FakeScheduler implements ReplayScheduler {
  private nextHandle = 1;
  private readonly entries = new Map<number, TimerEntry>();
  readonly delays: number[] = [];

  setTimeout(callback: () => void, delayMs: number): ReplayTimerHandle {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.entries.set(handle, { handle, callback, delayMs, cancelled: false, fired: false });
    this.delays.push(delayMs);
    return handle;
  }

  clearTimeout(handle: ReplayTimerHandle): void {
    if (typeof handle !== 'number') throw new TypeError('The test scheduler received a non-numeric handle');
    const entry = this.entries.get(handle);
    assert.ok(entry, 'the transport cleared an unknown timer');
    entry.cancelled = true;
  }

  get activeCount(): number {
    return [...this.entries.values()].filter((entry) => !entry.cancelled && !entry.fired).length;
  }

  get lastHandle(): number {
    return this.nextHandle - 1;
  }

  fire(handle: number, includeCancelled = false): void {
    const entry = this.entries.get(handle);
    assert.ok(entry, 'the test fired an unknown timer');
    if (entry.cancelled && !includeCancelled) return;
    entry.fired = true;
    entry.callback();
  }

  fireNext(): void {
    const entry = [...this.entries.values()].find((candidate) => !candidate.cancelled && !candidate.fired);
    assert.ok(entry, 'expected a pending timer');
    this.fire(entry.handle);
  }
}

function setup(replay: Replay = opening, options: Parameters<typeof createReplayTransport>[1] = {}) {
  const controller = createReplayController();
  const loaded = controller.load(replay);
  assert.equal(loaded.ok, true);
  const scheduler = options.scheduler ?? new FakeScheduler();
  const transport = createReplayTransport(controller, { ...options, scheduler });
  return { controller, scheduler, transport };
}

function fakeScheduler(scheduler: ReplayScheduler): FakeScheduler {
  assert.ok(scheduler instanceof FakeScheduler);
  return scheduler;
}

test('transport exposes exact cursor boundaries and stateful controls', () => {
  const { controller, scheduler, transport } = setup();
  const fake = fakeScheduler(scheduler);

  assert.deepEqual(transport.snapshot(), {
    currentPly: 0,
    length: 3,
    replayStatus: 'ready',
    speed: 1,
    paused: true,
    playing: false,
    boardFlipped: false,
    atStart: true,
    atEnd: false,
    canPlay: true,
    canPause: false,
    canStepBack: false,
    canStepForward: true,
    canJumpToStart: false,
    canJumpToEnd: true,
    timerPending: false,
  });

  assert.equal(transport.play(), true);
  assert.equal(transport.snapshot().playing, true);
  assert.equal(fake.delays.at(-1), 1000);
  fake.fireNext();
  assert.equal(controller.currentPly(), 1);
  assert.equal(transport.snapshot().timerPending, true);

  transport.pause();
  assert.equal(transport.snapshot().paused, true);
  assert.equal(fake.activeCount, 0);

  assert.equal(transport.stepForward().ok, true);
  assert.equal(controller.currentPly(), 2);
  assert.equal(transport.stepBack().ok, true);
  assert.equal(controller.currentPly(), 1);
  assert.equal(transport.first().ok, true);
  assert.equal(controller.currentPly(), 0);
  assert.equal(transport.last().ok, true);
  assert.equal(controller.currentPly(), 3);
  assert.equal(transport.snapshot().replayStatus, 'ended');
  assert.equal(transport.snapshot().canPlay, false);
  assert.equal(transport.play(), false);
  assert.equal(fake.activeCount, 0);
});

test('manual seeks use integer controller boundaries and reject invalid targets without mutation', () => {
  let cancelledAnimations = 0;
  const { controller, scheduler, transport } = setup(opening, {
    onCancelAnimation: () => { cancelledAnimations += 1; },
  });
  const fake = fakeScheduler(scheduler);

  transport.play();
  const staleHandle = fake.lastHandle;
  const invalid = transport.seek(1.5);
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.error.code, 'E_REPLAY_RANGE');
  assert.equal(controller.currentPly(), 0);
  assert.equal(transport.snapshot().paused, true);
  assert.equal(fake.activeCount, 0);
  assert.equal(cancelledAnimations, 1);

  assert.equal(transport.seek(2).ok, true);
  assert.equal(controller.currentPly(), 2);
  assert.equal(controller.presentationSnapshot()?.after_ply, 2);
  assert.equal(cancelledAnimations, 2);

  // A scheduler may still deliver a callback after clearTimeout; the generation guard makes it inert.
  fake.fire(staleHandle, true);
  assert.equal(controller.currentPly(), 2);
  assert.equal(transport.snapshot().timerPending, false);
});

test('speed changes cancel and reschedule one timer at the exact replay intervals', () => {
  const { scheduler, transport } = setup();
  const fake = fakeScheduler(scheduler);

  assert.equal(replayDelayMs(0.5), 2000);
  assert.equal(replayDelayMs(1), 1000);
  assert.equal(replayDelayMs(2), 500);
  assert.equal(transport.setSpeed(0.5).speed, 0.5);
  assert.equal(fake.activeCount, 0);

  transport.play();
  const slowHandle = fake.lastHandle;
  assert.equal(fake.delays.at(-1), 2000);
  assert.equal(fake.activeCount, 1);

  transport.setSpeed(2);
  assert.equal(fake.activeCount, 1);
  assert.equal(fake.delays.at(-1), 500);
  const fastHandle = fake.lastHandle;
  fake.fire(slowHandle, true);
  assert.equal(transport.snapshot().currentPly, 0);
  fake.fire(fastHandle);
  assert.equal(transport.snapshot().currentPly, 1);

  transport.setSpeed(1);
  assert.equal(fake.activeCount, 1);
  assert.equal(fake.delays.at(-1), 1000);
  transport.pause();
  assert.equal(fake.activeCount, 0);
});

test('rapid repeated seeks leave the final authoritative position and no stale autoplay', () => {
  let cancelledAnimations = 0;
  const { controller, scheduler, transport } = setup(opening, {
    onCancelAnimation: () => { cancelledAnimations += 1; },
  });
  const fake = fakeScheduler(scheduler);

  transport.play();
  const staleHandle = fake.lastHandle;
  for (const ply of [3, 1, 0, 2, 3]) assert.equal(transport.seek(ply).ok, true);
  assert.equal(controller.currentPly(), 3);
  assert.equal(controller.presentationSnapshot()?.after_ply, 3);
  assert.equal(transport.snapshot().paused, true);
  assert.equal(transport.snapshot().timerPending, false);
  assert.equal(cancelledAnimations, 5);

  fake.fire(staleHandle, true);
  assert.equal(controller.currentPly(), 3);
  assert.equal(controller.presentationSnapshot()?.after_ply, 3);
});

test('autoplay ends paused and can resume only after seeking away from the end', () => {
  const { controller, scheduler, transport } = setup();
  const fake = fakeScheduler(scheduler);

  transport.play();
  fake.fireNext();
  fake.fireNext();
  fake.fireNext();
  assert.equal(controller.currentPly(), 3);
  assert.equal(transport.snapshot().paused, true);
  assert.equal(transport.snapshot().timerPending, false);
  assert.equal(transport.play(), false);

  assert.equal(transport.seek(2).ok, true);
  assert.equal(transport.play(), true);
  assert.equal(fake.activeCount, 1);
});

test('board flip changes display state without disturbing cursor, playback, or timer', () => {
  const { controller, scheduler, transport } = setup();
  const fake = fakeScheduler(scheduler);

  transport.play();
  const handleBeforeFlip = fake.lastHandle;
  const delaysBeforeFlip = [...fake.delays];
  const beforeFlip = controller.position();
  const flipped = transport.toggleBoardFlip();
  assert.equal(flipped.boardFlipped, true);
  assert.equal(flipped.currentPly, 0);
  assert.equal(flipped.playing, true);
  assert.equal(flipped.timerPending, true);
  assert.deepEqual(controller.position(), beforeFlip);
  assert.deepEqual(fake.delays, delaysBeforeFlip);
  assert.equal(fake.lastHandle, handleBeforeFlip);

  fake.fireNext();
  assert.equal(controller.currentPly(), 1);
  assert.equal(transport.snapshot().boardFlipped, true);
  transport.pause();
  const pausedFlip = transport.setBoardFlipped(false);
  assert.equal(pausedFlip.paused, true);
  assert.equal(pausedFlip.currentPly, 1);
  assert.equal(pausedFlip.boardFlipped, false);
});

test('empty replays are ended and expose no playable controls or timers', () => {
  const { controller, scheduler, transport } = setup({ ...opening, moves: [] });
  const fake = fakeScheduler(scheduler);
  const state = transport.snapshot();

  assert.equal(controller.status(), 'ended');
  assert.equal(state.currentPly, 0);
  assert.equal(state.length, 0);
  assert.equal(state.replayStatus, 'ended');
  assert.equal(state.paused, true);
  assert.equal(state.canPlay, false);
  assert.equal(state.canStepBack, false);
  assert.equal(state.canStepForward, false);
  assert.equal(state.canJumpToStart, false);
  assert.equal(state.canJumpToEnd, false);
  assert.equal(transport.play(), false);
  assert.equal(fake.activeCount, 0);
  assert.equal(transport.first().ok, true);
  assert.equal(transport.last().ok, true);
  assert.equal(transport.stepForward().ok, true);
  assert.equal(transport.stepBack().ok, true);
  assert.equal(fake.activeCount, 0);
});
