import type { Color } from '../replay/schema.ts';
import type { PresentationSnapshot } from '../replay/presentation.ts';
import type { NavigationResult } from '../replay/controller.ts';
import {
  createDefaultViewerState,
  moveContext,
  replayMetadataText,
  type ReplaySpeed,
} from './viewer-shell.ts';
import { createBoard3DRenderer } from './board3d.ts';
import { buildReplayMoveList } from './replay-move-list.ts';
import { browserReplayScheduler, createReplayTransport } from './replay-transport.ts';

const $ = <T extends Element>(selector: string): T => {
  const element = document.querySelector(selector);
  if (element === null) throw new Error('Missing viewer UI element: ' + selector);
  return element as T;
};

const elements = {
  root: $<HTMLElement>('#replay-viewer'),
  board: $<HTMLElement>('#viewer-board'),
  boardState: $<HTMLElement>('#viewer-board-state'),
  boardOrientation: $<HTMLElement>('#viewer-board-orientation'),
  white: $<HTMLElement>('#replay-white'),
  black: $<HTMLElement>('#replay-black'),
  result: $<HTMLElement>('#replay-result'),
  event: $<HTMLElement>('#replay-event'),
  site: $<HTMLElement>('#replay-site'),
  source: $<HTMLElement>('#viewer-source'),
  ply: $<HTMLElement>('#replay-ply'),
  currentMove: $<HTMLElement>('#viewer-current-move'),
  liveStatus: $<HTMLElement>('#viewer-live-status'),
  transportStatus: $<HTMLElement>('#viewer-transport-status'),
  play: $<HTMLButtonElement>('#viewer-play'),
  first: $<HTMLButtonElement>('#viewer-first'),
  previous: $<HTMLButtonElement>('#viewer-previous'),
  next: $<HTMLButtonElement>('#viewer-next'),
  last: $<HTMLButtonElement>('#viewer-last'),
  flip: $<HTMLButtonElement>('#viewer-board-flip'),
  speed: $<HTMLSelectElement>('#viewer-speed'),
  timeline: $<HTMLInputElement>('#viewer-timeline'),
  timelineCurrent: $<HTMLElement>('#viewer-timeline-current'),
  timelineEnd: $<HTMLElement>('#viewer-timeline-end'),
  moveList: $<HTMLOListElement>('#viewer-move-list'),
};

const model = createDefaultViewerState();
const boardRenderer = createBoard3DRenderer(elements.board);
const displayMoves = buildReplayMoveList(model.replay);
const speedOptions: Record<string, ReplaySpeed> = { '0.5': 0.5, '1': 1, '2': 2 };
const transport = createReplayTransport(model.controller, {
  scheduler: browserReplayScheduler,
  onCancelAnimation: () => boardRenderer.cancelAnimation(),
  onChange: () => render(),
  onError: (error) => reportNavigationError(error.message),
});

function sideLabel(side: Color): string {
  return side === 'white' ? 'White' : 'Black';
}

function resultLabel(result: string): string {
  if (result === '1-0') return '1-0 · White wins';
  if (result === '0-1') return '0-1 · Black wins';
  if (result === '1/2-1/2') return '1/2-1/2 · Draw';
  return '* · In progress';
}

function reducedMotionEnabled(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function renderBoard(snapshot: PresentationSnapshot): void {
  boardRenderer.setFlipped(model.boardFlipped);
  boardRenderer.render(snapshot, model.controller.lastTransition(), { reducedMotion: reducedMotionEnabled() });
  elements.board.dataset.orientation = model.boardFlipped ? 'black' : 'white';
  elements.board.dataset.renderer = boardRenderer.status;
  elements.boardOrientation.textContent = model.boardFlipped ? 'Black perspective' : 'White perspective';
}

function markCurrentMove(button: HTMLButtonElement, ply: number, currentPly: number): void {
  if (ply === currentPly) button.setAttribute('aria-current', 'step');
  else button.removeAttribute('aria-current');
}

function renderMoveList(currentPly: number): void {
  elements.moveList.replaceChildren();
  const rootItem = document.createElement('li');
  rootItem.className = 'viewer-move-item viewer-root-move';
  const rootButton = document.createElement('button');
  rootButton.className = 'viewer-move-button';
  rootButton.type = 'button';
  rootButton.dataset.ply = '0';
  rootButton.textContent = 'Start · ' + sideLabel(model.rootState.side_to_move) + ' to move';
  markCurrentMove(rootButton, 0, currentPly);
  rootButton.addEventListener('click', () => seekTo(0));
  rootItem.append(rootButton);
  elements.moveList.append(rootItem);

  for (const entry of displayMoves) {
    const context = moveContext(model.rootState, entry.ply);
    const item = document.createElement('li');
    item.className = 'viewer-move-item';
    const button = document.createElement('button');
    button.className = 'viewer-move-button ' + (context.side === 'white' ? 'is-white' : 'is-black');
    button.type = 'button';
    button.dataset.ply = String(entry.ply);
    button.dataset.canonicalMove = entry.canonical;
    button.dataset.san = entry.san;
    button.textContent = entry.notation;
    button.setAttribute('aria-label', 'Seek to ply ' + entry.ply + ', ' + entry.fullmove + ' ' + sideLabel(entry.side) + ' ' + entry.san);
    markCurrentMove(button, entry.ply, currentPly);
    button.addEventListener('click', () => seekTo(entry.ply));
    item.append(button);
    elements.moveList.append(item);
  }
}

function render(snapshot: PresentationSnapshot = model.controller.presentationSnapshot()!): void {
  const transportState = transport.snapshot();
  model.paused = transportState.paused;
  model.boardFlipped = transportState.boardFlipped;
  model.speed = transportState.speed;
  const currentPly = transportState.currentPly;
  const length = transportState.length;
  const position = model.controller.position();
  if (position === null) throw new Error('Viewer controller has no authoritative position');
  const recordedResult = replayMetadataText(model.replay, 'result', position.outcome?.result ?? '*');

  renderBoard(snapshot);
  renderMoveList(currentPly);
  elements.root.dataset.playbackState = transportState.paused ? 'paused' : 'playing';
  elements.root.dataset.currentPly = String(currentPly);
  elements.white.textContent = replayMetadataText(model.replay, 'white', 'White');
  elements.black.textContent = replayMetadataText(model.replay, 'black', 'Black');
  elements.result.textContent = resultLabel(recordedResult);
  elements.event.textContent = replayMetadataText(model.replay, 'event', 'Curated replay');
  elements.site.textContent = replayMetadataText(model.replay, 'site', 'Local replay fixture');
  elements.source.textContent = replayMetadataText(model.replay, 'source', 'shared/replay-fixtures/opening.json');
  elements.ply.textContent = currentPly + ' / ' + length;
  elements.currentMove.textContent = currentPly === 0
    ? 'Root position'
    : 'Ply ' + currentPly + ' · ' + (displayMoves[currentPly - 1]?.san ?? 'unknown move');
  elements.boardState.textContent = 'Ply ' + currentPly + ' of ' + length + '. ' + sideLabel(position.side_to_move) + ' to move.';
  elements.transportStatus.textContent = transportState.paused ? 'Paused · ready to watch' : 'Playing · ply ' + currentPly;
  elements.liveStatus.textContent = elements.boardState.textContent + ' ' + (transportState.paused ? 'Paused.' : 'Playing.');
  elements.play.textContent = transportState.paused ? 'Play' : 'Pause';
  elements.play.setAttribute('aria-pressed', String(transportState.playing));
  elements.play.disabled = !transportState.canPlay;
  elements.first.disabled = !transportState.canJumpToStart;
  elements.previous.disabled = !transportState.canStepBack;
  elements.next.disabled = !transportState.canStepForward;
  elements.last.disabled = !transportState.canJumpToEnd;
  elements.flip.setAttribute('aria-pressed', String(transportState.boardFlipped));
  elements.speed.value = String(transportState.speed);
  elements.timeline.min = '0';
  elements.timeline.max = String(length);
  elements.timeline.value = String(currentPly);
  elements.timeline.disabled = length === 0;
  elements.timelineCurrent.textContent = String(currentPly);
  elements.timelineEnd.textContent = String(length);
}

function reportNavigationError(message: string): void {
  elements.liveStatus.textContent = message;
  elements.transportStatus.textContent = message;
}

function reportNavigationResult(result: NavigationResult): void {
  if (!result.ok) {
    reportNavigationError(result.error.message);
  }
}

function seekTo(ply: number): void {
  reportNavigationResult(transport.seek(ply));
}

function stepForward(): void {
  reportNavigationResult(transport.stepForward());
}

function stepBack(): void {
  reportNavigationResult(transport.stepBack());
}

function togglePlayback(): void {
  transport.togglePlayback();
}

function setSpeed(value: string): void {
  const speed = speedOptions[value];
  if (speed === undefined) {
    elements.speed.value = '1';
    transport.setSpeed(1);
    return;
  }
  transport.setSpeed(speed);
}

elements.play.addEventListener('click', togglePlayback);
elements.first.addEventListener('click', () => seekTo(0));
elements.previous.addEventListener('click', stepBack);
elements.next.addEventListener('click', stepForward);
elements.last.addEventListener('click', () => reportNavigationResult(transport.last()));
elements.flip.addEventListener('click', () => transport.toggleBoardFlip());
elements.speed.addEventListener('change', () => setSpeed(elements.speed.value));
elements.timeline.addEventListener('input', () => seekTo(Number(elements.timeline.value)));
window.addEventListener('keydown', (event) => {
  const target = event.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement || target instanceof HTMLButtonElement) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.code === 'Space') {
    event.preventDefault();
    togglePlayback();
  } else if (event.key === 'ArrowLeft') {
    event.preventDefault();
    stepBack();
  } else if (event.key === 'ArrowRight') {
    event.preventDefault();
    stepForward();
  } else if (event.key === 'Home') {
    event.preventDefault();
    seekTo(0);
  } else if (event.key === 'End') {
    event.preventDefault();
    seekTo(model.controller.length());
  }
});

render();
