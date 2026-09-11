import type { Replay } from './schema.ts';

export interface CuratedReplayEntry {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly replay: Replay;
}

const sourceUrl = 'https://github.com/devin-thomas/chess/tree/main/replay';

export const CURATED_REPLAYS = [
  {
    id: 'opening',
    title: 'Opening fixture',
    description: 'A clean first exchange that keeps the canonical cursor easy to read.',
    replay: {
      schema_version: 1,
      ruleset: 'orthodox-chess-v1',
      root: { kind: 'standard' },
      moves: ['e2e4', 'e7e5', 'g1f3'],
      metadata: {
        white: 'Fixture White',
        black: 'Fixture Black',
        result: '1-0',
        event: 'Opening fixture',
        source: 'Repository-authored canonical replay',
        source_url: sourceUrl,
        annotation: { ignored: true },
      },
    },
  },
  {
    id: 'italian-castle',
    title: 'Italian, then castle',
    description: 'A compact development line that exercises a complete king-and-rook castle.',
    replay: {
      schema_version: 1,
      ruleset: 'orthodox-chess-v1',
      root: { kind: 'standard' },
      moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'g8f6', 'd2d3', 'f8c5', 'e1g1'],
      metadata: {
        white: 'Open File',
        black: 'Closed File',
        result: '*',
        event: 'Curated technical line',
        source: 'Repository-authored canonical replay',
        source_url: sourceUrl,
      },
    },
  },
  {
    id: 'en-passant',
    title: 'The disappearing pawn',
    description: 'A short constructed study where the fifth ply removes a pawn from a different square.',
    replay: {
      schema_version: 1,
      ruleset: 'orthodox-chess-v1',
      root: { kind: 'standard' },
      moves: ['e2e4', 'a7a6', 'e4e5', 'd7d5', 'e5d6'],
      metadata: {
        white: 'Passing Pawn',
        black: 'The Interposer',
        result: '*',
        event: 'En passant study',
        source: 'Repository-authored canonical replay',
        source_url: sourceUrl,
      },
    },
  },
  {
    id: 'fools-mate',
    title: 'Four-ply finish',
    description: 'The fastest checkmate in the technical library, useful for testing terminal presentation.',
    replay: {
      schema_version: 1,
      ruleset: 'orthodox-chess-v1',
      root: { kind: 'standard' },
      moves: ['f2f3', 'e7e5', 'g2g4', 'd8h4'],
      metadata: {
        white: 'Unprepared King',
        black: 'Diagonal Queen',
        result: '0-1',
        event: 'Checkmate study',
        source: 'Repository-authored canonical replay',
        source_url: sourceUrl,
      },
    },
  },
] as const satisfies readonly CuratedReplayEntry[];

export const DEFAULT_CURATED_REPLAY_ID = CURATED_REPLAYS[0].id;

export function curatedReplayById(id: string): CuratedReplayEntry | null {
  return CURATED_REPLAYS.find((entry) => entry.id === id) ?? null;
}

export function cloneCuratedReplay(id: string): Replay | null {
  const entry = curatedReplayById(id);
  return entry === null ? null : structuredClone(entry.replay);
}
