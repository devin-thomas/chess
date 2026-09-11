import { createSimulator } from "../typescript/chess_cpu";

type JsonRecord = Record<string, unknown>;
type OperationMode = "single" | "batch";
type ChessMode = "basic" | "all-rules-enabled";
type BoardColor = "white" | "black";
type BoardPieceType = "king" | "queen" | "rook" | "bishop" | "knight" | "pawn";
type BoardPiece = { color: BoardColor; type: BoardPieceType };
type Board = Array<BoardPiece | null>;

interface BoardView {
  board: Board;
  sideToMove: BoardColor;
  fullmove: number;
  ply: number;
  lastMove: { from: number; to: number; notation: string } | null;
}

const DEFAULT_MAX_PLIES = 600;
const START_BOARD_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const FEN_PIECES: Record<string, BoardPiece> = {
  K: { color: "white", type: "king" },
  Q: { color: "white", type: "queen" },
  R: { color: "white", type: "rook" },
  B: { color: "white", type: "bishop" },
  N: { color: "white", type: "knight" },
  P: { color: "white", type: "pawn" },
  k: { color: "black", type: "king" },
  q: { color: "black", type: "queen" },
  r: { color: "black", type: "rook" },
  b: { color: "black", type: "bishop" },
  n: { color: "black", type: "knight" },
  p: { color: "black", type: "pawn" },
};
const PIECE_GLYPHS: Record<BoardColor, Record<BoardPieceType, string>> = {
  white: { king: "♔", queen: "♕", rook: "♖", bishop: "♗", knight: "♘", pawn: "♙" },
  black: { king: "♚", queen: "♛", rook: "♜", bishop: "♝", knight: "♞", pawn: "♟" },
};
const PROMOTION_TYPES: Record<string, BoardPieceType> = {
  q: "queen",
  r: "rook",
  b: "bishop",
  n: "knight",
};

const $ = <T extends Element>(selector: string): T => {
  const element = document.querySelector(selector);
  if (element === null) throw new Error("Missing UI element: " + selector);
  return element as T;
};

const elements = {
  modeRun: $<HTMLButtonElement>("#mode-run"),
  modeBatch: $<HTMLButtonElement>("#mode-batch"),
  chessMode: $<HTMLSelectElement>("#chess-mode"),
  seed: $<HTMLInputElement>("#seed"),
  maxPlies: $<HTMLInputElement>("#max-plies"),
  batchCountField: $<HTMLElement>("#batch-count-field"),
  batchCount: $<HTMLInputElement>("#batch-count"),
  runButton: $<HTMLButtonElement>("#run-button"),
  stopButton: $<HTMLButtonElement>("#stop-button"),
  status: $<HTMLElement>("#status-message"),
  progress: $<HTMLElement>("#progress-message"),
  advanced: $<HTMLDetailsElement>("#advanced"),
  fen: $<HTMLTextAreaElement>("#fen"),
  sampleCount: $<HTMLInputElement>("#sample-count"),
  trace: $<HTMLInputElement>("#trace"),
  terminalToggle: $<HTMLInputElement>("#terminal-toggle"),
  summaryHeading: $<HTMLElement>("#summary-heading"),
  summaryBadge: $<HTMLElement>("#summary-badge"),
  metricOutcome: $<HTMLElement>("#metric-outcome"),
  metricPlies: $<HTMLElement>("#metric-plies"),
  metricDuration: $<HTMLElement>("#metric-duration"),
  metricRate: $<HTMLElement>("#metric-rate"),
  metricTermination: $<HTMLElement>("#metric-termination"),
  distributionMeta: $<HTMLElement>("#distribution-meta"),
  distributionList: $<HTMLUListElement>("#distribution-list"),
  batchMeta: $<HTMLElement>("#batch-meta"),
  batchWhite: $<HTMLElement>("#batch-white"),
  batchDraws: $<HTMLElement>("#batch-draws"),
  batchBlack: $<HTMLElement>("#batch-black"),
  batchMean: $<HTMLElement>("#batch-mean"),
  batchMedian: $<HTMLElement>("#batch-median"),
  batchCompleted: $<HTMLElement>("#batch-completed"),
  batchCapped: $<HTMLElement>("#batch-capped"),
  board: $<HTMLElement>("#chess-board"),
  boardMeta: $<HTMLElement>("#board-meta"),
  boardTurn: $<HTMLElement>("#board-turn"),
  boardLastMove: $<HTMLElement>("#board-last-move"),
  playbackSpeed: $<HTMLSelectElement>("#playback-speed"),
  playbackNote: $<HTMLElement>("#playback-note"),
  terminalDetails: $<HTMLDetailsElement>("#terminal-details"),
  terminalMeta: $<HTMLElement>("#terminal-meta"),
  terminalOutput: $<HTMLPreElement>("#terminal-output"),
  clearTerminal: $<HTMLButtonElement>("#clear-terminal"),
};

const integerFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});
const decimalFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
});
const u64Mask = (1n << 64n) - 1n;

let operationMode: OperationMode = "single";
let busy = false;
let cancelled = false;
let terminalLines: string[] = [];
let boardSquares: HTMLElement[] = [];

function record(value: unknown): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Engine returned an invalid response.");
  }
  return value as JsonRecord;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function integerValue(value: unknown, fallback: number): number {
  return Math.max(0, Math.round(numberValue(value, fallback)));
}

function responseError(response: JsonRecord): string {
  const error = response.error;
  if (typeof error === "object" && error !== null && !Array.isArray(error)) {
    const message = (error as JsonRecord).message;
    if (typeof message === "string") return message;
  }
  return "The engine rejected the request.";
}

function requestEngine(payload: JsonRecord): JsonRecord {
  const response = record(createSimulator().request(payload));
  if (response.ok !== true) throw new Error(responseError(response));
  return response;
}

function clampField(input: HTMLInputElement, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(input.value);
  const value = Number.isFinite(parsed) ? Math.round(parsed) : fallback;
  const clamped = Math.min(maximum, Math.max(minimum, value));
  input.value = String(clamped);
  return clamped;
}

function randomSeed(): string {
  const words = new Uint32Array(2);
  crypto.getRandomValues(words);
  return ((BigInt(words[1]) << 32n) | BigInt(words[0])).toString(10);
}

function normalizeSeed(value: string): string {
  try {
    const trimmed = value.trim();
    const seed = trimmed.length === 0 ? randomSeed() : trimmed;
    const normalized = (BigInt(seed) & u64Mask).toString(10);
    elements.seed.value = normalized;
    return normalized;
  } catch {
    const seed = randomSeed();
    elements.seed.value = seed;
    return seed;
  }
}

function batchSeed(base: string, index: number): string {
  return ((BigInt(base) + BigInt(index)) & u64Mask).toString(10);
}

function formatInteger(value: number): string {
  return integerFormatter.format(Math.max(0, Math.round(value)));
}

function formatDecimal(value: number, digits = 1): string {
  if (digits === 1) return decimalFormatter.format(value);
  return value.toFixed(digits);
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1000) return formatDecimal(milliseconds, 0) + " ms";
  return formatDecimal(milliseconds / 1000, 2) + " s";
}

function boardSquareIndex(file: number, rank: number): number {
  return rank * 8 + file;
}

function boardSquareName(square: number): string {
  return "abcdefgh"[square % 8] + String(Math.floor(square / 8) + 1);
}

function boardIndexFromName(value: string): number {
  if (!/^[a-h][1-8]$/.test(value)) throw new Error("Engine returned an invalid square.");
  return boardSquareIndex("abcdefgh".indexOf(value[0]), Number(value[1]) - 1);
}

function cloneBoard(board: Board): Board {
  return board.map((piece) => piece === null ? null : { ...piece });
}

function cloneBoardView(view: BoardView): BoardView {
  return {
    board: cloneBoard(view.board),
    sideToMove: view.sideToMove,
    fullmove: view.fullmove,
    ply: view.ply,
    lastMove: view.lastMove === null ? null : { ...view.lastMove },
  };
}

function parseBoardFen(value: string): BoardView {
  const fields = value.trim().split(/\s+/);
  const ranks = (fields[0] ?? "").split("/");
  if (ranks.length !== 8) throw new Error("FEN must contain eight board ranks.");

  const board: Board = Array.from({ length: 64 }, () => null);
  for (let fenRank = 0; fenRank < 8; fenRank += 1) {
    let file = 0;
    for (const character of ranks[fenRank]) {
      if (/^[1-8]$/.test(character)) {
        file += Number(character);
        continue;
      }
      const piece = FEN_PIECES[character];
      if (piece === undefined) throw new Error("FEN contains an invalid piece.");
      if (file >= 8) throw new Error("FEN contains too many files in a rank.");
      board[boardSquareIndex(file, 7 - fenRank)] = { ...piece };
      file += 1;
    }
    if (file !== 8) throw new Error("FEN contains a rank with the wrong width.");
  }

  const side = fields[1] ?? "w";
  if (side !== "w" && side !== "b") throw new Error("FEN side-to-move must be w or b.");
  const fullmoveText = fields[5] ?? "1";
  if (!/^\d+$/.test(fullmoveText) || Number(fullmoveText) < 1) {
    throw new Error("FEN fullmove number is out of range.");
  }
  return {
    board,
    sideToMove: side === "w" ? "white" : "black",
    fullmove: Number(fullmoveText),
    ply: 0,
    lastMove: null,
  };
}

function resetBoard(): BoardView {
  const fen = elements.fen.value.trim();
  const view = parseBoardFen(fen.length === 0 ? START_BOARD_FEN : fen);
  renderBoard(view);
  return view;
}

function pieceDescription(piece: BoardPiece): string {
  return piece.color + " " + piece.type;
}

function buildBoard(): void {
  const cells: HTMLElement[] = [];
  elements.board.replaceChildren();
  for (let rank = 7; rank >= 0; rank -= 1) {
    for (let file = 0; file < 8; file += 1) {
      const square = boardSquareIndex(file, rank);
      const cell = document.createElement("div");
      cell.className = "board-square " + ((file + rank) % 2 === 0 ? "is-light" : "is-dark");
      cell.setAttribute("role", "gridcell");
      cell.setAttribute("aria-rowindex", String(8 - rank));
      cell.setAttribute("aria-colindex", String(file + 1));

      const piece = document.createElement("span");
      piece.className = "board-piece";
      piece.setAttribute("aria-hidden", "true");
      cell.append(piece);

      if (rank === 0) {
        const fileLabel = document.createElement("span");
        fileLabel.className = "board-coordinate board-file";
        fileLabel.textContent = "abcdefgh"[file];
        fileLabel.setAttribute("aria-hidden", "true");
        cell.append(fileLabel);
      }
      if (file === 0) {
        const rankLabel = document.createElement("span");
        rankLabel.className = "board-coordinate board-rank";
        rankLabel.textContent = String(rank + 1);
        rankLabel.setAttribute("aria-hidden", "true");
        cell.append(rankLabel);
      }
      cells[square] = cell;
      elements.board.append(cell);
    }
  }
  boardSquares = cells;
}

function renderBoard(view: BoardView): void {
  for (let square = 0; square < 64; square += 1) {
    const cell = boardSquares[square];
    if (cell === undefined) throw new Error("Board UI is not initialized.");
    const pieceElement = cell.querySelector<HTMLElement>(".board-piece");
    if (pieceElement === null) throw new Error("Board UI is missing a piece layer.");
    const piece = view.board[square];
    pieceElement.className = piece === null ? "board-piece" : "board-piece piece-" + piece.color;
    pieceElement.textContent = piece === null ? "" : PIECE_GLYPHS[piece.color][piece.type];
    cell.classList.toggle("is-last-from", view.lastMove?.from === square);
    cell.classList.toggle("is-last-to", view.lastMove?.to === square);
    cell.setAttribute(
      "aria-label",
      boardSquareName(square) + ": " + (piece === null ? "empty" : pieceDescription(piece)),
    );
  }

  const turn = view.sideToMove === "white" ? "White to move" : "Black to move";
  elements.boardMeta.textContent = view.ply === 0
    ? "Starting position - " + turn.toLowerCase()
    : formatInteger(view.ply) + " plies - " + turn.toLowerCase();
  elements.boardTurn.textContent = turn;
  elements.boardLastMove.textContent = view.lastMove?.notation ?? "-";
}

function parseBoardMove(value: string): {
  from: number;
  to: number;
  promotion: BoardPieceType | undefined;
} {
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(value)) {
    throw new Error("Engine returned an invalid move trace.");
  }
  return {
    from: boardIndexFromName(value.slice(0, 2)),
    to: boardIndexFromName(value.slice(2, 4)),
    promotion: value.length === 5 ? PROMOTION_TYPES[value[4]] : undefined,
  };
}

function applyBoardMove(view: BoardView, notation: string): void {
  const move = parseBoardMove(notation);
  const moving = view.board[move.from];
  if (moving === null) throw new Error("Cannot visualize " + notation + ": source square is empty.");

  const fromFile = move.from % 8;
  const toFile = move.to % 8;
  const captured = view.board[move.to];
  view.board[move.from] = null;

  if (moving.type === "pawn" && fromFile !== toFile && captured === null) {
    const capturedSquare = move.to + (moving.color === "white" ? -8 : 8);
    const enPassantPawn = view.board[capturedSquare];
    if (enPassantPawn === null || enPassantPawn.type !== "pawn") {
      throw new Error("Cannot visualize " + notation + ": en passant capture is inconsistent.");
    }
    view.board[capturedSquare] = null;
  }

  if (moving.type === "king" && Math.abs(toFile - fromFile) === 2) {
    const rank = Math.floor(move.from / 8);
    const rookFrom = boardSquareIndex(toFile > fromFile ? 7 : 0, rank);
    const rookTo = boardSquareIndex(toFile > fromFile ? 5 : 3, rank);
    const rook = view.board[rookFrom];
    if (rook === null || rook.type !== "rook") {
      throw new Error("Cannot visualize " + notation + ": castling rook is missing.");
    }
    view.board[rookFrom] = null;
    view.board[rookTo] = { ...rook };
  }

  if (move.promotion !== undefined && moving.type !== "pawn") {
    throw new Error("Cannot visualize " + notation + ": promotion is not a pawn move.");
  }
  view.board[move.to] = move.promotion === undefined
    ? { ...moving }
    : { color: moving.color, type: move.promotion };
  view.sideToMove = view.sideToMove === "white" ? "black" : "white";
  if (moving.color === "black") view.fullmove += 1;
  view.ply += 1;
  view.lastMove = { from: move.from, to: move.to, notation };
}

function moveSequenceFromResponse(response: JsonRecord): string[] {
  const final = response.final;
  if (typeof final === "object" && final !== null && !Array.isArray(final)) {
    const finalMoves = (final as JsonRecord).moves;
    if (Array.isArray(finalMoves)) {
      if (!finalMoves.every((move) => typeof move === "string")) {
        throw new Error("Engine returned an invalid move trace.");
      }
      return finalMoves as string[];
    }
  }
  if (!Array.isArray(response.moves)) return [];
  if (!response.moves.every((move) => typeof move === "string")) {
    throw new Error("Engine returned an invalid move trace.");
  }
  return response.moves as string[];
}

function boardAfterResponse(initial: BoardView, response: JsonRecord): BoardView {
  const view = cloneBoardView(initial);
  for (const move of moveSequenceFromResponse(response)) applyBoardMove(view, move);
  return view;
}

function playbackDelay(): number {
  const value = Number(elements.playbackSpeed.value);
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function updatePlaybackNote(): void {
  const delay = playbackDelay();
  elements.playbackNote.textContent = delay === 0
    ? "Full speed renders the final position immediately."
    : formatDuration(delay) + " between plies for easier viewing.";
}

function waitForPlayback(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const started = performance.now();
    const tick = (): void => {
      const remaining = milliseconds - (performance.now() - started);
      if (cancelled || remaining <= 0) {
        resolve();
        return;
      }
      window.setTimeout(tick, Math.min(50, remaining));
    };
    tick();
  });
}

function outcomeLabel(result: string): string {
  if (result === "1-0") return "White wins";
  if (result === "0-1") return "Black wins";
  if (result === "1/2-1/2") return "Draw";
  return "Unfinished";
}

function setStatus(message: string, kind: "ready" | "busy" | "error" = "ready"): void {
  elements.status.textContent = message;
  elements.status.className = kind === "ready" ? "" : "is-" + kind;
}

function setBusy(nextBusy: boolean): void {
  busy = nextBusy;
  elements.runButton.disabled = nextBusy;
  elements.modeRun.disabled = nextBusy;
  elements.modeBatch.disabled = nextBusy;
  elements.chessMode.disabled = nextBusy;
  elements.seed.disabled = nextBusy;
  elements.maxPlies.disabled = nextBusy;
  elements.batchCount.disabled = nextBusy;
  elements.fen.disabled = nextBusy;
  elements.sampleCount.disabled = nextBusy;
  elements.trace.disabled = nextBusy;
  elements.terminalToggle.disabled = nextBusy;
  elements.stopButton.hidden = !nextBusy;
}

function setMetric(element: HTMLElement, value: string): void {
  element.textContent = value;
}

function resetSummary(title: string): void {
  elements.summaryHeading.textContent = title;
  elements.summaryBadge.textContent = "waiting";
  setMetric(elements.metricOutcome, "-");
  setMetric(elements.metricPlies, "-");
  setMetric(elements.metricDuration, "-");
  setMetric(elements.metricRate, "-");
  setMetric(elements.metricTermination, "-");
}

function resetBatchStats(): void {
  setMetric(elements.batchWhite, "-");
  setMetric(elements.batchDraws, "-");
  setMetric(elements.batchBlack, "-");
  setMetric(elements.batchMean, "-");
  setMetric(elements.batchMedian, "-");
  setMetric(elements.batchCompleted, "-");
  setMetric(elements.batchCapped, "-");
}

function buildRunRequest(seed: string): JsonRecord {
  const request: JsonRecord = {
    op: "run",
    mode: elements.chessMode.value as ChessMode,
    seed,
    max_plies: clampField(elements.maxPlies, DEFAULT_MAX_PLIES, 0, 5000),
    trace: elements.trace.checked,
  };
  const fen = elements.fen.value.trim();
  if (fen.length > 0) request.fen = fen;
  return request;
}

function buildSampleRequest(seed: string, samples: number): JsonRecord {
  const request: JsonRecord = {
    op: "sample",
    seed,
    samples,
  };
  const fen = elements.fen.value.trim();
  if (fen.length > 0) request.fen = fen;
  return request;
}

function compactTerminalPayload(payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return payload;
  const copy: JsonRecord = { ...(payload as JsonRecord) };
  for (const key of ["moves", "sequence"]) {
    const value = copy[key];
    if (!Array.isArray(value) || value.length <= 80) continue;
    copy[key] = {
      first: value.slice(0, 40),
      last: value.slice(-40),
      omitted: value.length - 80,
    };
  }
  return copy;
}

function appendTerminal(label: string, payload: unknown): void {
  if (!elements.terminalToggle.checked) return;
  terminalLines.push("[" + label + "]");
  terminalLines.push(JSON.stringify(compactTerminalPayload(payload), null, 2));
  if (terminalLines.length > 240) terminalLines = terminalLines.slice(-240);
  elements.terminalOutput.textContent = terminalLines.join("\n");
  elements.terminalMeta.textContent = terminalLines.length + " lines";
  elements.terminalDetails.hidden = false;
}

function renderDistribution(response: JsonRecord): void {
  const countsValue = response.counts;
  if (typeof countsValue !== "object" || countsValue === null || Array.isArray(countsValue)) {
    elements.distributionList.replaceChildren();
    const empty = document.createElement("li");
    empty.className = "empty-state";
    empty.textContent = "No legal moves in the sampled position.";
    elements.distributionList.append(empty);
    return;
  }
  const entries = Object.entries(countsValue as JsonRecord)
    .map(([move, count]) => [move, numberValue(count, 0)] as [string, number])
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const samples = integerValue(response.samples, 0);
  elements.distributionMeta.textContent = formatInteger(samples) + " opening samples";
  elements.distributionList.replaceChildren();
  if (entries.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty-state";
    empty.textContent = "No legal moves in the sampled position.";
    elements.distributionList.append(empty);
    return;
  }
  const maximum = Math.max(1, entries[0][1]);
  for (const [move, count] of entries) {
    const item = document.createElement("li");
    item.className = "distribution-row";
    const name = document.createElement("span");
    name.className = "move-name";
    name.textContent = move;
    const track = document.createElement("span");
    track.className = "distribution-track";
    const fill = document.createElement("span");
    fill.className = "distribution-fill";
    fill.style.width = Math.max(2, (count / maximum) * 100) + "%";
    track.append(fill);
    const countLabel = document.createElement("span");
    countLabel.className = "move-count";
    countLabel.textContent = formatInteger(count);
    item.append(name, track, countLabel);
    elements.distributionList.append(item);
  }
}

function renderSingle(response: JsonRecord, elapsed: number): void {
  const result = stringValue(response.result, "*");
  const termination = stringValue(response.termination, "unknown");
  const plies = integerValue(response.plies, 0);
  elements.summaryHeading.textContent = outcomeLabel(result);
  elements.summaryBadge.textContent = result;
  setMetric(elements.metricOutcome, outcomeLabel(result));
  setMetric(elements.metricPlies, formatInteger(plies));
  setMetric(elements.metricDuration, formatDuration(elapsed));
  setMetric(elements.metricRate, formatInteger(plies / Math.max(elapsed / 1000, 0.001)) + " ply/s");
  setMetric(elements.metricTermination, termination.replaceAll("_", " "));
  elements.batchMeta.textContent = "single-run mode";
  resetBatchStats();
}

function renderBatch(
  results: JsonRecord[],
  elapsed: number,
  requested: number,
  wasCancelled: boolean,
): void {
  let white = 0;
  let black = 0;
  let draws = 0;
  let capped = 0;
  const plies: number[] = [];
  for (const result of results) {
    const outcome = stringValue(result.result, "*");
    if (outcome === "1-0") white += 1;
    else if (outcome === "0-1") black += 1;
    else if (outcome === "1/2-1/2") draws += 1;
    else if (outcome === "*") capped += 1;
    plies.push(integerValue(result.plies, 0));
  }
  const total = plies.reduce((sum, value) => sum + value, 0);
  const sorted = [...plies].sort((left, right) => left - right);
  const median = sorted.length === 0
    ? 0
    : sorted.length % 2 === 0
      ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
      : sorted[Math.floor(sorted.length / 2)];
  elements.summaryHeading.textContent = wasCancelled ? "Stopped" : "Batch complete";
  elements.summaryBadge.textContent = formatInteger(results.length) + "/" + formatInteger(requested);
  setMetric(elements.metricOutcome, formatInteger(results.length) + " runs");
  setMetric(elements.metricPlies, formatInteger(total));
  setMetric(elements.metricDuration, formatDuration(elapsed));
  setMetric(
    elements.metricRate,
    formatDecimal(results.length / Math.max(elapsed / 1000, 0.001), 1) + " sims/s",
  );
  setMetric(
    elements.metricTermination,
    wasCancelled
      ? "stopped at " + formatInteger(results.length)
      : capped === 0
        ? "all runs terminal"
        : formatInteger(capped) + " capped",
  );
  elements.batchMeta.textContent = formatInteger(results.length) + " runs";
  setMetric(elements.batchWhite, formatInteger(white));
  setMetric(elements.batchDraws, formatInteger(draws));
  setMetric(elements.batchBlack, formatInteger(black));
  setMetric(elements.batchMean, sorted.length === 0 ? "-" : formatDecimal(total / sorted.length) + " plies");
  setMetric(elements.batchMedian, sorted.length === 0 ? "-" : formatDecimal(median) + " plies");
  setMetric(elements.batchCompleted, formatInteger(results.length));
  setMetric(elements.batchCapped, formatInteger(capped));
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}

async function replaySingle(response: JsonRecord, initial: BoardView): Promise<void> {
  const moves = moveSequenceFromResponse(response);
  const view = cloneBoardView(initial);
  if (moves.length === 0) {
    renderBoard(view);
    return;
  }

  const delay = playbackDelay();
  if (delay === 0) {
    for (const move of moves) applyBoardMove(view, move);
    renderBoard(view);
    elements.progress.textContent = formatInteger(moves.length) + " plies";
    return;
  }

  setStatus("Watching", "busy");
  for (let index = 0; index < moves.length; index += 1) {
    if (cancelled) break;
    applyBoardMove(view, moves[index]);
    renderBoard(view);
    elements.progress.textContent = "Ply " + formatInteger(index + 1) + " / " + formatInteger(moves.length);
    if (index < moves.length - 1) await waitForPlayback(delay);
  }
}

async function runSingle(): Promise<void> {
  const initialBoard = resetBoard();
  const seed = normalizeSeed(elements.seed.value);
  const started = performance.now();
  const response = requestEngine(buildRunRequest(seed));
  const elapsed = performance.now() - started;
  renderSingle(response, elapsed);
  appendTerminal("run " + seed, response);
  await replaySingle(response, initialBoard);

  const samples = clampField(elements.sampleCount, 1000, 0, 5000);
  if (samples > 0) {
    const sampleResponse = requestEngine(buildSampleRequest(seed, samples));
    renderDistribution(sampleResponse);
    appendTerminal("sample " + seed, sampleResponse);
  } else {
    elements.distributionMeta.textContent = "sampling disabled";
  }
}

async function runBatch(): Promise<void> {
  const initialBoard = resetBoard();
  const requested = clampField(elements.batchCount, 100, 1, 1000);
  const baseSeed = normalizeSeed(elements.seed.value);
  const results: JsonRecord[] = [];
  const started = performance.now();
  for (let index = 0; index < requested; index += 1) {
    if (cancelled) break;
    const seed = batchSeed(baseSeed, index);
    const response = requestEngine(buildRunRequest(seed));
    results.push(response);
    if (index % 4 === 3 || index === requested - 1) renderBoard(boardAfterResponse(initialBoard, response));
    if (elements.terminalToggle.checked) appendTerminal("run " + seed, response);
    elements.progress.textContent = formatInteger(results.length) + " / " + formatInteger(requested);
    if (index % 4 === 3) await yieldToBrowser();
  }
  const elapsed = performance.now() - started;
  const stopped = cancelled;
  renderBatch(results, elapsed, requested, stopped);

  const samples = clampField(elements.sampleCount, 1000, 0, 5000);
  if (samples > 0 && results.length > 0) {
    const sampleResponse = requestEngine(buildSampleRequest(baseSeed, samples));
    renderDistribution(sampleResponse);
    appendTerminal("sample " + baseSeed, sampleResponse);
  } else if (samples === 0) {
    elements.distributionMeta.textContent = "sampling disabled";
  }
}

async function execute(): Promise<void> {
  if (busy) return;
  cancelled = false;
  setBusy(true);
  setStatus(operationMode === "single" ? "Running" : "Running batch", "busy");
  elements.progress.textContent = "";
  try {
    if (operationMode === "single") await runSingle();
    else await runBatch();
    setStatus(cancelled ? "Stopped" : "Ready");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(message, "error");
    appendTerminal("error", { ok: false, error: message });
  } finally {
    setBusy(false);
    elements.progress.textContent = "";
  }
}

function setOperationMode(nextMode: OperationMode): void {
  operationMode = nextMode;
  const single = nextMode === "single";
  elements.modeRun.classList.toggle("is-active", single);
  elements.modeBatch.classList.toggle("is-active", !single);
  elements.modeRun.setAttribute("aria-selected", String(single));
  elements.modeBatch.setAttribute("aria-selected", String(!single));
  elements.batchCountField.hidden = single;
  resetSummary(single ? "Ready" : "Batch ready");
  resetBatchStats();
  elements.batchMeta.textContent = single ? "single-run mode" : "batch mode";
}

elements.modeRun.addEventListener("click", () => setOperationMode("single"));
elements.modeBatch.addEventListener("click", () => setOperationMode("batch"));
elements.runButton.addEventListener("click", () => {
  void execute();
});
elements.stopButton.addEventListener("click", () => {
  if (busy) {
    cancelled = true;
    setStatus("Stopping after the current run", "busy");
  }
});
elements.terminalToggle.addEventListener("change", () => {
  elements.terminalDetails.hidden = !elements.terminalToggle.checked;
  if (elements.terminalToggle.checked) elements.terminalDetails.open = true;
});
elements.clearTerminal.addEventListener("click", () => {
  terminalLines = [];
  elements.terminalOutput.textContent = "";
  elements.terminalMeta.textContent = "No output yet";
});
elements.advanced.addEventListener("toggle", () => {
  if (elements.advanced.open) elements.fen.focus();
});
elements.playbackSpeed.addEventListener("change", updatePlaybackNote);
elements.fen.addEventListener("change", () => {
  if (busy) return;
  try {
    resetBoard();
    setStatus("Ready");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(message, "error");
  }
});

buildBoard();
elements.seed.value = randomSeed();
resetBoard();
updatePlaybackNote();
resetBatchStats();
