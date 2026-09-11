import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname } from 'node:path';
import { createReplaySession } from '../replay/engine.ts';
import { createReplayController } from '../replay/controller.ts';
import type { Replay } from '../replay/schema.ts';

function buildLongReplay(targetLength = 80): Replay {
  const session = createReplaySession({ kind: 'standard' });
  const moves: string[] = [];
  let seed = 0x12345678;
  while (moves.length < targetLength) {
    const state = session.state();
    const legalMoves = session.legalMoves();
    if (state.outcome !== null || legalMoves.length === 0) break;
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const move = legalMoves[seed % legalMoves.length];
    moves.push(move);
    session.play(move);
  }
  if (moves.length < 64) throw new Error(`Long replay generator stopped at ${moves.length} plies`);
  return { schema_version: 1, ruleset: 'orthodox-chess-v1', root: { kind: 'standard' }, moves };
}

function samplePlies(length: number, count = 32): number[] {
  const samples: number[] = [];
  let seed = 0x9e3779b9;
  for (let index = 0; index < count; index += 1) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    samples.push(seed % (length + 1));
  }
  return samples;
}

function measure(controller: ReturnType<typeof createReplayController>, plies: readonly number[]): number[] {
  return plies.map((ply) => {
    const start = performance.now();
    const result = controller.seek(ply);
    if (!result.ok) throw result.error;
    return Number(Math.max(0, performance.now() - start).toFixed(3));
  });
}

const replay = buildLongReplay();
const plies = samplePlies(replay.moves.length);
const uncached = createReplayController({ cache: 'none' });
const cached = createReplayController({ cache: 'full' });
if (!uncached.load(replay).ok || !cached.load(replay).ok) throw new Error('Benchmark replay failed validation');
const uncachedSamples = measure(uncached, plies);
const cachedSamples = measure(cached, plies);
const average = (samples: readonly number[]) => Number((samples.reduce((sum, value) => sum + value, 0) / samples.length).toFixed(3));
const report = {
  schema_version: 1,
  environment: {
    runtime: 'node',
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpu: cpus()[0]?.model ?? 'unknown',
    browser: 'not applicable (Node controller benchmark)',
  },
  measurement: 'seek only; replay validation and cache construction are excluded',
  replay_length: replay.moves.length,
  sample_count: plies.length,
  sampled_plies: plies,
  uncached_ms: { average: average(uncachedSamples), samples: uncachedSamples },
  cached_ms: { average: average(cachedSamples), samples: cachedSamples },
  controller_cache: cached.cacheStats(),
};

const outputPathIndex = process.argv.indexOf('--json-out');
if (outputPathIndex !== -1) {
  const outputPath = process.argv[outputPathIndex + 1];
  if (!outputPath) throw new Error('--json-out requires a path');
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
