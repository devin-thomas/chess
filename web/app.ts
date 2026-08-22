import { createSimulator } from "../typescript/chess_cpu";

type JsonRecord = Record<string, unknown>;
type OperationMode = "single" | "batch";
type ChessMode = "basic" | "all-rules-enabled";

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
  extraStatistics: $<HTMLInputElement>("#extra-statistics"),
  trace: $<HTMLInputElement>("#trace"),
  terminalToggle: $<HTMLInputElement>("#terminal-toggle"),
  batchProgress: $<HTMLProgressElement>("#batch-progress"),
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
  batchCapped: $<HTMLElement>("#batch-capped"),
  terminalDetails: $<HTMLDetailsElement>("#terminal-details"),
  terminalMeta: $<HTMLElement>("#terminal-meta"),
  terminalOutput: $<HTMLPreElement>("#terminal-output"),
  expandTerminal: $<HTMLButtonElement>("#expand-terminal"),
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
const simulator = createSimulator();

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
  const response = record(simulator.request(payload));
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

function normalizeSeed(value: string): string {
  try {
    return (BigInt(value.trim() || "1") & u64Mask).toString(10);
  } catch {
    elements.seed.value = "1";
    return "1";
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
  elements.extraStatistics.disabled = nextBusy;
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
  setMetric(elements.batchCapped, "-");
}

function buildRunRequest(seed: string): JsonRecord {
  const request: JsonRecord = {
    op: "run",
    mode: elements.chessMode.value as ChessMode,
    seed,
    max_plies: clampField(elements.maxPlies, 200, 0, 5000),
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
  const plies: number[] = [];
  for (const result of results) {
    const outcome = stringValue(result.result, "*");
    if (outcome === "1-0") white += 1;
    else if (outcome === "0-1") black += 1;
    else if (outcome === "1/2-1/2") draws += 1;
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
    wasCancelled ? "stopped at " + formatInteger(results.length) : "batch finished",
  );
  elements.batchMeta.textContent = formatInteger(results.length) + " completed";
  setMetric(elements.batchWhite, formatInteger(white));
  setMetric(elements.batchDraws, formatInteger(draws));
  setMetric(elements.batchBlack, formatInteger(black));
  setMetric(elements.batchMean, sorted.length === 0 ? "-" : formatDecimal(total / sorted.length) + " plies");
  setMetric(elements.batchMedian, sorted.length === 0 ? "-" : formatDecimal(median) + " plies");
  setMetric(elements.batchCompleted, formatInteger(results.length));
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}

async function runSingle(): Promise<void> {
  const seed = normalizeSeed(elements.seed.value);
  const started = performance.now();
  const response = requestEngine(buildRunRequest(seed));
  const elapsed = performance.now() - started;
  renderSingle(response, elapsed);
  appendTerminal("run " + seed, response);

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
  const requested = clampField(elements.batchCount, 100, 1, 1000);
  const baseSeed = normalizeSeed(elements.seed.value);
  const results: JsonRecord[] = [];
  const started = performance.now();
  for (let index = 0; index < requested; index += 1) {
    if (cancelled) break;
    const seed = batchSeed(baseSeed, index);
    const response = requestEngine(buildRunRequest(seed));
    results.push(response);
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

resetBatchStats();
