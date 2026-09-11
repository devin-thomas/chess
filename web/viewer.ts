import type { Color } from '../replay/schema.ts';
import type { PresentationSnapshot } from '../replay/presentation.ts';
import {
  boardSquareOrder,
  createDefaultViewerState,
  moveContext,
  PIECE_GLYPHS,
  piecesBySquare,
  replayMetadataText,
  type ReplaySpeed,
} from './viewer-shell.ts';

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
let playbackTimer: number | null = null;
const speedOptions: Record<string, ReplaySpeed> = { '0.5': 0.5, '1': 1, '2': 2 };

function sideLabel(side: Color): string {
  return side === 'white' ? 'White' : 'Black';
}

function resultLabel(result: string): string {
  if (result === '1-0') return '1-0 · White wins';
  if (result === '0-1') return '0-1 · Black wins';
  if (result === '1/2-1/2') return '1/2-1/2 · Draw';
  return '* · In progress';
}

function squareIndex(square: string): number {
  return 'abcdefgh'.indexOf(square[0]) + (Number(square[1]) - 1) * 8;
}

function clearPlaybackTimer(): void {
  if (playbackTimer !== null) {
    window.clearTimeout(playbackTimer);
    playbackTimer = null;
  }
}

function renderBoard(snapshot: PresentationSnapshot): void {
  const pieces = piecesBySquare(snapshot);
  const fragment = document.createDocumentFragment();
  for (const squareName of boardSquareOrder(model.boardFlipped)) {
    const index = squareIndex(squareName);
    const file = index % 8;
    const rank = Math.floor(index / 8);
    const cell = document.createElement('div');
    cell.className = 'viewer-board-square ' + ((file + rank) % 2 === 0 ? 'is-light' : 'is-dark');
    cell.dataset.square = squareName;
    cell.setAttribute('role', 'gridcell');
    const piece = pieces.get(squareName);
    cell.setAttribute('aria-label', squareName + ': ' + (piece ? piece.color + ' ' + piece.piece_type : 'empty'));

    const pieceElement = document.createElement('span');
    pieceElement.className = piece ? 'viewer-piece piece-' + piece.color : 'viewer-piece';
    pieceElement.setAttribute('aria-hidden', 'true');
    pieceElement.textContent = piece ? PIECE_GLYPHS[piece.color][piece.piece_type] : '';
    cell.append(pieceElement);

    if (file === 0) {
      const rankLabel = document.createElement('span');
      rankLabel.className = 'viewer-coordinate viewer-rank';
      rankLabel.textContent = String(rank + 1);
      rankLabel.setAttribute('aria-hidden', 'true');
      cell.append(rankLabel);
    }
    if (rank === 0) {
      const fileLabel = document.createElement('span');
      fileLabel.className = 'viewer-coordinate viewer-file';
      fileLabel.textContent = 'abcdefgh'[file];
      fileLabel.setAttribute('aria-hidden', 'true');
      cell.append(fileLabel);
    }
    fragment.append(cell);
  }
  elements.board.replaceChildren(fragment);
  elements.board.dataset.orientation = model.boardFlipped ? 'black' : 'white';
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

  for (let ply = 1; ply <= model.replay.moves.length; ply += 1) {
    const move = model.controller.moveAt(ply);
    if (move === null) throw new Error('Default replay move list is missing ply ' + ply);
    const context = moveContext(model.rootState, ply);
    const item = document.createElement('li');
    item.className = 'viewer-move-item';
    const button = document.createElement('button');
    button.className = 'viewer-move-button ' + (context.side === 'white' ? 'is-white' : 'is-black');
    button.type = 'button';
    button.dataset.ply = String(ply);
    button.dataset.canonicalMove = move;
    button.textContent = context.fullmove + (context.side === 'white' ? '.' : '...') + ' ' + move;
    button.setAttribute('aria-label', 'Seek to ply ' + ply + ', ' + context.fullmove + ' ' + sideLabel(context.side) + ' ' + move);
    markCurrentMove(button, ply, currentPly);
    button.addEventListener('click', () => seekTo(ply));
    item.append(button);
    elements.moveList.append(item);
  }
}

function render(snapshot: PresentationSnapshot = model.controller.presentationSnapshot()!): void {
  const currentPly = model.controller.currentPly();
  const length = model.controller.length();
  const position = model.controller.position();
  if (position === null) throw new Error('Viewer controller has no authoritative position');
  const recordedResult = replayMetadataText(model.replay, 'result', position.outcome?.result ?? '*');

  renderBoard(snapshot);
  renderMoveList(currentPly);
  elements.root.dataset.playbackState = model.paused ? 'paused' : 'playing';
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
    : 'Ply ' + currentPly + ' · ' + (model.controller.moveAt(currentPly) ?? 'unknown move');
  elements.boardState.textContent = 'Ply ' + currentPly + ' of ' + length + '. ' + sideLabel(position.side_to_move) + ' to move.';
  elements.transportStatus.textContent = model.paused ? 'Paused · ready to watch' : 'Playing · ply ' + currentPly;
  elements.liveStatus.textContent = elements.boardState.textContent + ' ' + (model.paused ? 'Paused.' : 'Playing.');
  elements.play.textContent = model.paused ? 'Play' : 'Pause';
  elements.play.setAttribute('aria-pressed', String(!model.paused));
  elements.first.disabled = currentPly === 0;
  elements.previous.disabled = currentPly === 0;
  elements.next.disabled = currentPly >= length;
  elements.last.disabled = currentPly >= length;
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

function seekTo(ply: number): void {
  clearPlaybackTimer();
  model.paused = true;
  const result = model.controller.seek(ply);
  if (!result.ok) {
    reportNavigationError(result.error.message);
    render();
    return;
  }
  render();
}

function stepForward(): void {
  clearPlaybackTimer();
  model.paused = true;
  const result = model.controller.stepForward();
  if (!result.ok) {
    reportNavigationError(result.error.message);
    render();
    return;
  }
  render();
}

function stepBack(): void {
  clearPlaybackTimer();
  model.paused = true;
  const result = model.controller.stepBack();
  if (!result.ok) {
    reportNavigationError(result.error.message);
    render();
    return;
  }
  render();
}

function schedulePlayback(): void {
  clearPlaybackTimer();
  if (model.paused) return;
  if (model.controller.currentPly() >= model.controller.length()) {
    model.paused = true;
    render();
    return;
  }
  playbackTimer = window.setTimeout(() => {
    playbackTimer = null;
    if (model.paused) return;
    const result = model.controller.stepForward();
    if (!result.ok) {
      model.paused = true;
      reportNavigationError(result.error.message);
      render();
      return;
    }
    render();
    schedulePlayback();
  }, 1000 / model.speed);
}

function togglePlayback(): void {
  if (!model.paused) {
    model.paused = true;
    clearPlaybackTimer();
    render();
    return;
  }
  if (model.controller.currentPly() >= model.controller.length()) return;
  model.paused = false;
  render();
  schedulePlayback();
}

function setSpeed(value: string): void {
  const speed = speedOptions[value];
  if (speed === undefined) {
    elements.speed.value = '1';
    model.speed = 1;
    return;
  }
  model.speed = speed;
  if (!model.paused) schedulePlayback();
}

elements.play.addEventListener('click', togglePlayback);
elements.first.addEventListener('click', () => seekTo(0));
elements.previous.addEventListener('click', stepBack);
elements.next.addEventListener('click', stepForward);
elements.last.addEventListener('click', () => seekTo(model.controller.length()));
elements.flip.addEventListener('click', () => {
  model.boardFlipped = !model.boardFlipped;
  elements.flip.setAttribute('aria-pressed', String(model.boardFlipped));
  render();
});
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
